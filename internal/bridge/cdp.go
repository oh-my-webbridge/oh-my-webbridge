package bridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// pageClientSession names the session of a new page CDP client: "cdp-" and
// 32 random hex digits, the form that extension/src/state.ts recognizes. The
// name stays inside the daemon and the extension, and a session name that an
// agent picks, such as "cdp-research", does not take this form by chance.
func pageClientSession() string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never returns an error.
	return "cdp-" + hex.EncodeToString(b[:])
}

// firefoxOnly answers a request for the extension CDP transport while only the
// Firefox extension, which has no CDP, is connected.
func (s *Server) firefoxOnly(w http.ResponseWriter) bool {
	if s.Hub.ConnectedTo(Chrome) || !s.Hub.ConnectedTo(Firefox) {
		return false
	}
	replyError(w, "", &Fault{"unsupported", "CDP endpoints are not available in Firefox; connect the Chrome extension"})
	return true
}

func (s *Server) targets(w http.ResponseWriter, r *http.Request) {
	if s.firefoxOnly(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	result, err := s.Hub.CallBrowser(ctx, Chrome, Command{Action: "list_targets", Session: "cdp", Args: json.RawMessage(`{}`)})
	if err != nil {
		replyError(w, "", err)
		return
	}
	var targets []struct {
		TabID int    `json:"tabId"`
		URL   string `json:"url"`
		Title string `json:"title"`
	}
	if err = json.Unmarshal(result, &targets); err != nil {
		replyError(w, "", err)
		return
	}
	out := make([]map[string]any, 0, len(targets))
	for _, t := range targets {
		out = append(out, map[string]any{"id": strconv.Itoa(t.TabID), "type": "page", "url": t.URL, "title": t.Title, "webSocketDebuggerUrl": fmt.Sprintf("ws://%s/devtools/page/%d", r.Host, t.TabID)})
	}
	jsonOut(w, 200, out)
}
func (s *Server) version(w http.ResponseWriter, r *http.Request) {
	out := map[string]string{"Browser": "oh-my-webbridge/" + Version, "Protocol-Version": "1.3", "User-Agent": "oh-my-webbridge", "transport": "chrome.debugger (page targets only)"}
	if s.Config.CDP != "" {
		out["webSocketDebuggerUrl"] = "ws://" + r.Host + "/devtools/browser"
		out["transport"] = "native CDP passthrough"
	} else if s.firefoxOnly(w) {
		return
	}
	jsonOut(w, 200, out)
}

func (s *Server) pageCDP(w http.ResponseWriter, r *http.Request) {
	tab, err := strconv.Atoi(r.PathValue("tab"))
	if err != nil || tab <= 0 {
		http.Error(w, "invalid tab", 400)
		return
	}
	if s.firefoxOnly(w) {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session := pageClientSession()
	args, _ := json.Marshal(map[string]int{"tabId": tab})
	attachCtx, attachCancel := context.WithTimeout(ctx, 5*time.Second)
	cleanup := func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, _ = s.Hub.Cleanup(ctx, Chrome, Command{Action: "cdp_detach", Session: session, Args: args})
	}
	// The extension forwards the tab's events once the attach succeeds, which
	// can be before its reply arrives; subscribing first keeps them.
	events, unsubscribe := s.Hub.Subscribe(tab)
	defer unsubscribe()
	_, err = s.Hub.CallBrowser(attachCtx, Chrome, Command{Action: "cdp_attach", Session: session, Args: args})
	attachCancel()
	if err != nil {
		// After a deadline or cancellation the extension may still finish the
		// attach; release the tab as when a client disconnects.
		if fault(err).Code == "outcome_unknown" {
			cleanup()
		}
		replyError(w, "", err)
		return
	}
	defer cleanup()
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	// A command, such as Runtime.evaluate with a large script, may be as large
	// as any message to the extension.
	c.SetReadLimit(MaxMessage)
	// forward writes one event and reports whether the connection stays open.
	forward := func(event Packet) bool {
		out := map[string]any{"method": event.Method, "params": event.Params}
		if event.SessionID != "" {
			out["sessionId"] = event.SessionID
		}
		if err := wsjson.Write(ctx, c, out); err != nil {
			return false
		}
		// The page's own detach means its target is closed or no longer
		// debuggable. Chrome's page endpoint then closes the connection;
		// closing it here ends the reader below, and the deferred cleanup
		// ends the extension session.
		if event.Method == "Inspector.detached" && event.SessionID == "" {
			_ = c.Close(websocket.StatusNormalClosure, "target detached")
			return false
		}
		return true
	}
	// Events that arrived during the attach reach the client before the reply
	// to its first command.
	for queued := len(events); queued > 0; queued-- {
		event, ok := <-events
		if !ok || !forward(event) {
			return
		}
	}
	go func() {
		defer cancel()
		for {
			select {
			case event, ok := <-events:
				if !ok || !forward(event) {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	// The reader accepts commands while replies/events are in flight. Bound the work;
	// never create a goroutine per unbounded input frame.
	limit := make(chan struct{}, 32)
	var workers sync.WaitGroup
	defer workers.Wait()
	defer cancel()
	for {
		var in struct {
			ID        json.RawMessage `json:"id"`
			Method    string          `json:"method"`
			Params    json.RawMessage `json:"params"`
			SessionID string          `json:"sessionId,omitempty"`
		}
		if err = wsjson.Read(ctx, c, &in); err != nil {
			return
		}
		if len(in.ID) == 0 || in.Method == "" {
			return
		}
		select {
		case limit <- struct{}{}:
		case <-ctx.Done():
			return
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() { <-limit }()
			callCtx, stop := context.WithTimeout(ctx, 30*time.Second)
			defer stop()
			raw, _ := json.Marshal(map[string]any{"tabId": tab, "method": in.Method, "params": in.Params, "sessionId": in.SessionID})
			result, err := s.Hub.CallBrowser(callCtx, Chrome, Command{Action: "cdp", Session: session, Args: raw})
			out := map[string]any{"id": in.ID}
			if err != nil {
				out["error"] = map[string]any{"code": -32000, "message": err.Error()}
			} else {
				out["result"] = result
			}
			if in.SessionID != "" {
				out["sessionId"] = in.SessionID
			}
			if err = wsjson.Write(ctx, c, out); err != nil {
				cancel()
			}
		}()
	}
}

func (s *Server) browserCDP(w http.ResponseWriter, r *http.Request) {
	if s.Config.CDP == "" {
		if !s.firefoxOnly(w) {
			http.Error(w, "native browser CDP is not configured", 503)
		}
		return
	}
	if _, err := ParseCDP(s.Config.CDP); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dialCtx, dialCancel := context.WithTimeout(ctx, 10*time.Second)
	upstream, _, err := websocket.Dial(dialCtx, s.Config.CDP, nil)
	dialCancel()
	if err != nil {
		http.Error(w, "native CDP connection failed", 502)
		return
	}
	defer upstream.CloseNow()
	downstream, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer downstream.CloseNow()
	upstream.SetReadLimit(MaxMessage)
	downstream.SetReadLimit(MaxMessage)
	var wg sync.WaitGroup
	copyFrames := func(to, from *websocket.Conn) {
		defer wg.Done()
		defer cancel()
		for {
			kind, data, err := from.Read(ctx)
			if err != nil {
				return
			}
			if err = to.Write(ctx, kind, data); err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go copyFrames(upstream, downstream)
	go copyFrames(downstream, upstream)
	wg.Wait()
}
