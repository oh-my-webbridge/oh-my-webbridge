package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// Browsers that can connect an extension. Chrome serves unbound sessions when
// both are connected and is the only one with CDP transport.
const (
	Chrome  = "chrome"
	Firefox = "firefox"
)

// MaxSessions bounds the session bindings of one browser; each extension holds
// at most 128 sessions.
const MaxSessions = 128

// frameWriteTimeout bounds writing one frame to an extension. Once a frame has
// started, its caller's deadline no longer applies to it: coder/websocket
// closes the connection when a write's context ends in the middle of a frame,
// which would fail every other command in flight on that connection. A frame
// that takes this long means the transport is stuck, and closing the
// connection is then the right outcome.
const frameWriteTimeout = 30 * time.Second

// Each browser connection takes maxPending ordinary commands. close_session and
// dialog, and the daemon's own cleanups sent through Cleanup, may use
// recoveryReserve more, matching each extension's reserve in
// extension/src/bridge.ts. Recovery still reaches a browser whose ordinary
// commands are all waiting on unresponsive pages, and a closed page CDP client
// or a finished PDF stream is released; commands waiting in one browser leave
// the other browser's slots free.
const maxPending = 128
const recoveryReserve = 16

func recovery(action string) bool { return action == "close_session" || action == "dialog" }

type pending struct {
	result    chan Packet
	bytes     int
	responded bool
	link      *link
}
type subscription struct {
	tab    int
	events chan Packet
}

// link is one connected extension. It reserves its browser from the hello
// until it closes and becomes ready, and so routable, once the daemon's hello
// reply holds the connection's first write turn.
type link struct {
	browser string
	version string
	conn    *websocket.Conn
	ready   bool
	// pending counts the commands in flight on this connection; h.mu guards it.
	pending int
	// Every frame to the extension is written at its turn in queue.
	queue writeQueue
	// closed is closed when the connection has ended.
	closed chan struct{}
}

// writeQueue gives out turns to write frames on one connection, one at a
// time and in the order they were taken. A turn taken before a call returns
// therefore comes before the turns of frames queued after it.
type writeQueue struct {
	mu      sync.Mutex
	busy    bool
	waiting []chan struct{}
}

// enter takes the next turn; the channel is closed when the turn comes.
func (q *writeQueue) enter() chan struct{} {
	q.mu.Lock()
	defer q.mu.Unlock()
	turn := make(chan struct{})
	if q.busy {
		q.waiting = append(q.waiting, turn)
	} else {
		q.busy = true
		close(turn)
	}
	return turn
}

// exit gives up a turn that has not come, or ends the current turn.
func (q *writeQueue) exit(turn chan struct{}) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if i := slices.Index(q.waiting, turn); i >= 0 {
		q.waiting = slices.Delete(q.waiting, i, i+1)
		return
	}
	if len(q.waiting) == 0 {
		q.busy = false
		return
	}
	close(q.waiting[0])
	q.waiting = slices.Delete(q.waiting, 0, 1)
}

var (
	errStopped = errors.New("the caller stopped waiting before the frame was written")
	errClosed  = errors.New("the connection closed before the frame was written")
)

// write sends data, one encoded frame, at turn, taken from l.queue.enter. It
// stops waiting when stop is closed or the connection ends; a frame that has
// started is written under frameWriteTimeout, whatever the caller's deadline.
// Frames are encoded before they wait for their turn, so frameWriteTimeout
// covers only the transport.
func (l *link) write(turn chan struct{}, stop <-chan struct{}, data []byte) error {
	defer l.queue.exit(turn)
	select {
	case <-turn:
	case <-stop:
		return errStopped
	case <-l.closed:
		return errClosed
	}
	select {
	case <-stop:
		return errStopped
	case <-l.closed:
		return errClosed
	default:
	}
	ctx, cancel := context.WithTimeout(context.Background(), frameWriteTimeout)
	defer cancel()
	return l.conn.Write(ctx, websocket.MessageText, data)
}

// encode encodes a frame the daemon composes itself, which cannot fail.
func encode(packet Packet) []byte {
	data, err := json.Marshal(packet)
	if err != nil {
		panic(err)
	}
	return data
}

// send writes one request frame. A command that ends before its frame starts
// is not sent.
func (l *link) send(ctx context.Context, packet Packet) error {
	data, err := json.Marshal(packet)
	if err != nil {
		return &Fault{"internal", "encode request: " + err.Error()}
	}
	err = l.write(l.queue.enter(), ctx.Done(), data)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errStopped):
		return expired()
	default:
		return &Fault{"outcome_unknown", "browser transport write failed: " + err.Error()}
	}
}

func expired() *Fault {
	return &Fault{"outcome_unknown", "request deadline/cancellation reached; observe before retrying"}
}

// BrowserStatus describes one connected extension in /status.
type BrowserStatus struct {
	Browser        string `json:"browser"`
	BrowserVersion string `json:"browserVersion,omitempty"`
	Connected      bool   `json:"connected"`
}

type Hub struct {
	mu       sync.Mutex
	links    map[string]*link
	pending  map[string]*pending
	subs     map[*subscription]struct{}
	bindings map[string]string
	buffered int
	// When store is set, the bindings are saved there. revision counts their
	// changes, saved is the revision last written, and saving orders the writes.
	store    string
	revision uint64
	saved    uint64
	saving   sync.Mutex
}

func NewHub() *Hub {
	return &Hub{links: make(map[string]*link), pending: make(map[string]*pending), subs: make(map[*subscription]struct{}), bindings: make(map[string]string)}
}

// live returns the ready connection of a browser. The caller holds h.mu.
func (h *Hub) live(browser string) *link {
	if l := h.links[browser]; l != nil && l.ready {
		return l
	}
	return nil
}

// Connected reports whether any browser is connected.
func (h *Hub) Connected() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.live(Chrome) != nil || h.live(Firefox) != nil
}

// ConnectedTo reports whether the given browser is connected.
func (h *Hub) ConnectedTo(browser string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.live(browser) != nil
}
func (h *Hub) Inflight() int { h.mu.Lock(); defer h.mu.Unlock(); return len(h.pending) }

// Browsers lists the connected extensions, Chrome first.
func (h *Hub) Browsers() []BrowserStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []BrowserStatus{}
	for _, browser := range []string{Chrome, Firefox} {
		if l := h.live(browser); l != nil {
			out = append(out, BrowserStatus{Browser: browser, BrowserVersion: l.version, Connected: true})
		}
	}
	return out
}

// Attach registers one browser connection, answers its hello and serves it
// until it closes. A second connection for an already connected browser is
// refused; the other browser's connection is unaffected.
func (h *Hub) Attach(ctx context.Context, c *websocket.Conn, browser, version string, sessions []string) error {
	l := &link{browser: browser, version: version, conn: c, closed: make(chan struct{})}
	h.mu.Lock()
	if h.links[browser] != nil {
		h.mu.Unlock()
		return &Fault{"browser_busy", browser + " is already connected"}
	}
	h.links[browser] = l
	conflicts := h.restore(browser, sessions)
	h.mu.Unlock()
	defer h.detach(l)
	h.save()
	if len(conflicts) > 0 {
		slog.Warn("hello sessions already bound to another browser; keeping the existing binding", "browser", browser, "sessions", conflicts)
	}
	// The hello reply takes the first write turn before the link becomes
	// routable: requests queue behind it, so the extension sees the reply before
	// any request, and an extension that has read the reply is already
	// routable. The hello and pong frames stop waiting for their turn when the
	// connection's context ends.
	hello := l.queue.enter()
	h.mu.Lock()
	l.ready = true
	h.mu.Unlock()
	if err := l.write(hello, ctx.Done(), encode(Packet{Type: "hello", Protocol: Protocol})); err != nil {
		return err
	}
	c.SetReadLimit(MaxMessage)
	for {
		var msg Packet
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			return err
		}
		if msg.Type == "ping" {
			if err := l.write(l.queue.enter(), ctx.Done(), encode(Packet{Type: "pong"})); err != nil {
				return err
			}
			continue
		}
		h.mu.Lock()
		if msg.Type == "response" {
			// A connection can only answer requests that were sent to it.
			if p := h.pending[msg.ID]; p != nil && p.link == l && !p.responded {
				if h.buffered+len(msg.Result) > 64<<20 {
					msg.Result = nil
					msg.Error = &Fault{"outcome_unknown", "response byte budget exhausted after command execution; observe before retrying"}
				}
				select {
				case p.result <- msg:
					p.responded = true
					p.bytes = len(msg.Result)
					h.buffered += p.bytes
				default:
				}
			}
		}
		// Raw CDP events exist only on the Chrome transport.
		if msg.Type == "event" && browser == Chrome {
			for s := range h.subs {
				if s.tab == msg.TabID {
					if len(msg.Params) > 256<<10 {
						close(s.events)
						delete(h.subs, s)
						continue
					}
					select {
					case s.events <- msg:
					default:
						close(s.events)
						delete(h.subs, s)
					}
				}
			}
		}
		h.mu.Unlock()
	}
}

// restore rebuilds bindings from the session list in a browser's hello. A
// binding to this browser that the list omits is stale (the extension no
// longer holds the session) and is removed. A name already bound to the other
// browser keeps that binding and is returned for a warning. A nil list (an
// extension without the field) leaves the bindings unchanged.
func (h *Hub) restore(browser string, sessions []string) []string {
	if sessions == nil {
		return nil
	}
	listed := make(map[string]bool, len(sessions))
	for _, name := range sessions {
		listed[name] = true
	}
	for name, bound := range h.bindings {
		if bound == browser && !listed[name] {
			delete(h.bindings, name)
			h.revision++
		}
	}
	var conflicts []string
	for _, name := range sessions {
		if bound, ok := h.bindings[name]; ok {
			if bound != browser {
				conflicts = append(conflicts, name)
			}
			continue
		}
		if h.count(browser) < MaxSessions {
			h.bindings[name] = browser
			h.revision++
		}
	}
	return conflicts
}

// detach removes a closed connection. Its in-flight commands become uncertain;
// session bindings stay so the extension continues them after reconnecting.
func (h *Hub) detach(l *link) {
	h.mu.Lock()
	defer h.mu.Unlock()
	close(l.closed)
	if h.links[l.browser] == l {
		delete(h.links, l.browser)
	}
	for _, p := range h.pending {
		if p.link != l {
			continue
		}
		select {
		case p.result <- Packet{Error: &Fault{"outcome_unknown", "browser disconnected; command may have executed; observe before retrying"}}:
		default:
		}
	}
	if l.browser == Chrome {
		for s := range h.subs {
			close(s.events)
			delete(h.subs, s)
		}
	}
}

func (h *Hub) count(browser string) int {
	n := 0
	for _, bound := range h.bindings {
		if bound == browser {
			n++
		}
	}
	return n
}

func offline(browser string) *Fault {
	return &Fault{"browser_offline", browser + " is not connected; connect its extension using omw connection"}
}

// route picks the connection for a session: an explicit browser must match an
// existing binding; otherwise the binding decides, and an unbound session uses
// Chrome when connected, else Firefox.
func (h *Hub) route(session, browser string) (*link, error) {
	bound, ok := h.bindings[session]
	target := browser
	switch {
	case browser != "" && ok && bound != browser:
		return nil, &Fault{"session_browser", fmt.Sprintf("session %s is bound to %s, not %s; close_session first to use it in %s", session, bound, browser, browser)}
	case browser == "" && ok:
		target = bound
	case browser == "" && h.live(Chrome) != nil:
		target = Chrome
	case browser == "" && h.live(Firefox) != nil:
		target = Firefox
	case browser == "":
		return nil, &Fault{"browser_offline", "connect the extension using omw connection"}
	}
	l := h.live(target)
	if l == nil {
		return nil, offline(target)
	}
	return l, nil
}

// Resolve reports the browser a command would be sent to without binding it.
func (h *Hub) Resolve(session, browser string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	l, err := h.route(session, browser)
	if err != nil {
		return "", err
	}
	return l.browser, nil
}

// Call sends a client command. The session is bound to the browser when the
// command is dispatched and unbound after a successful close_session; both
// changes are saved when the hub keeps its bindings in a file.
func (h *Hub) Call(ctx context.Context, cmd Command) (json.RawMessage, error) {
	return h.CallResolved(ctx, "", cmd)
}

// CallResolved sends a client command like Call, to the browser that Resolve
// returned for it; the caller holds that browser's command slot for it. When
// the session routes to the other browser at dispatch, because another
// command or a hello bound it there, close_session or a hello removed its
// binding, or the connected browsers changed, the command is not sent and
// returns busy, and a retry follows the new route. An empty browser accepts
// any route.
func (h *Hub) CallResolved(ctx context.Context, browser string, cmd Command) (json.RawMessage, error) {
	var target string
	result, err := h.call(ctx, cmd, recovery(cmd.Action), func() (*link, error) {
		l, err := h.route(cmd.Session, cmd.Browser)
		if err != nil || browser == "" || l.browser == browser {
			return l, err
		}
		return nil, rerouted(cmd.Session, browser, l.browser, h.bindings[cmd.Session] != "")
	}, func(l *link) error {
		if _, ok := h.bindings[cmd.Session]; !ok {
			if h.count(l.browser) >= MaxSessions {
				return &Fault{"busy", fmt.Sprintf("%d sessions are already bound to %s; close a session first", MaxSessions, l.browser)}
			}
			h.bindings[cmd.Session] = l.browser
			h.revision++
		}
		target = l.browser
		return nil
	})
	if err == nil && cmd.Action == "close_session" {
		h.mu.Lock()
		if h.bindings[cmd.Session] == target {
			delete(h.bindings, cmd.Session)
			h.revision++
		}
		h.mu.Unlock()
		h.save()
	}
	return result, err
}

// rerouted answers a command whose session now routes to another browser than
// the one it was resolved to: its command slot belongs to the resolved browser.
func rerouted(session, resolved, now string, bound bool) *Fault {
	if bound {
		return &Fault{"busy", fmt.Sprintf("session %s was just bound to %s by another command or the extension's hello; retry the command", session, now)}
	}
	return &Fault{"busy", fmt.Sprintf("session %s now goes to %s instead of %s: close_session or the extension's hello removed its binding, or the connected browsers changed; retry the command", session, now, resolved)}
}

// CallBrowser sends a transport-internal command to one browser without
// binding its session.
func (h *Hub) CallBrowser(ctx context.Context, browser string, cmd Command) (json.RawMessage, error) {
	return h.call(ctx, cmd, false, func() (*link, error) {
		if l := h.live(browser); l != nil {
			return l, nil
		}
		return nil, offline(browser)
	}, nil)
}

// Cleanup sends a transport-internal cleanup, cdp_detach or artifact_close,
// with the recovery reserve and without binding its session. It goes to
// browser, or with "" to the browser that Call would route the session to.
// HTTP clients reach Call, so the same actions sent to /command stay ordinary
// commands.
func (h *Hub) Cleanup(ctx context.Context, browser string, cmd Command) (json.RawMessage, error) {
	return h.call(ctx, cmd, true, func() (*link, error) {
		return h.route(cmd.Session, browser)
	}, nil)
}

// call sends cmd on the connection that pick chooses and waits for its reply.
// pick runs under the hub lock. The connection must have room for the
// command: maxPending commands, or recoveryReserve more when reserve is set.
// bind, when set, then runs under the same lock and may refuse the command.
func (h *Hub) call(ctx context.Context, cmd Command, reserve bool, pick func() (*link, error), bind func(*link) error) (json.RawMessage, error) {
	// Never reuse caller IDs on the transport: late replies cannot satisfy another call.
	id := NewID()
	p := &pending{result: make(chan Packet, 1)}
	h.mu.Lock()
	l, err := pick()
	if err != nil {
		h.mu.Unlock()
		return nil, err
	}
	limit := maxPending
	if reserve {
		limit += recoveryReserve
	}
	if l.pending >= limit {
		h.mu.Unlock()
		return nil, &Fault{"busy", fmt.Sprintf("%d requests already in flight to %s", limit, l.browser)}
	}
	if bind != nil {
		if err := bind(l); err != nil {
			h.mu.Unlock()
			return nil, err
		}
	}
	p.link = l
	l.pending++
	h.pending[id] = p
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.buffered -= p.bytes
		delete(h.pending, id)
		l.pending--
		h.mu.Unlock()
	}()
	// A binding that bind made is saved before its command is sent.
	h.save()
	deadline, _ := ctx.Deadline()
	if err := l.send(ctx, Packet{Type: "request", ID: id, Command: &cmd, Deadline: deadline.UnixMilli()}); err != nil {
		return nil, err
	}
	select {
	case msg := <-p.result:
		if msg.Error != nil {
			return nil, msg.Error
		}
		return msg.Result, nil
	case <-ctx.Done():
		// The cancel frame takes its turn now: it follows a frame that is
		// being written and precedes frames queued later. The command does
		// not wait for it, and it is not sent once the connection has ended.
		data, turn := encode(Packet{Type: "cancel", ID: id}), l.queue.enter()
		go func() { _ = l.write(turn, nil, data) }()
		return nil, expired()
	}
}

func (h *Hub) Subscribe(tab int) (<-chan Packet, func()) {
	s := &subscription{tab: tab, events: make(chan Packet, 32)}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s.events, func() {
		h.mu.Lock()
		if _, ok := h.subs[s]; ok {
			delete(h.subs, s)
			close(s.events)
		}
		h.mu.Unlock()
	}
}
func (h *Hub) Close() {
	h.mu.Lock()
	conns := make([]*websocket.Conn, 0, len(h.links))
	for _, l := range h.links {
		conns = append(conns, l.conn)
	}
	h.mu.Unlock()
	for _, c := range conns {
		_ = c.CloseNow()
	}
}

func fault(err error) *Fault {
	var e *Fault
	if errors.As(err, &e) {
		return e
	}
	return &Fault{"internal", err.Error()}
}
