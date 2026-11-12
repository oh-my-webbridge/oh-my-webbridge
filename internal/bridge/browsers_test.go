package bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/oh-my-webbridge/oh-my-webbridge/internal/config"
)

var (
	chromeExtension  = "chrome-extension://" + strings.Repeat("a", 32)
	firefoxExtension = "moz-extension://0c0ffee0-0000-4000-8000-000000000001"
)

func newServer(t *testing.T, c config.Config) (*Server, *httptest.Server) {
	t.Helper()
	c.Token = strings.Repeat("a", 64)
	c.Dir = t.TempDir()
	s := New(c)
	server := httptest.NewServer(s.Handler())
	t.Cleanup(server.Close)
	t.Cleanup(s.Hub.Close)
	return s, server
}

// dial opens /extension with an Origin and returns the upgrade status on failure.
func dial(t *testing.T, s *Server, server *httptest.Server, origin string) (*websocket.Conn, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/extension", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}, Subprotocols: []string{"omw.v1", "omw-token." + s.Config.Token}})
	if err != nil {
		if res == nil {
			t.Fatal(err)
		}
		return nil, res.StatusCode
	}
	t.Cleanup(func() { c.CloseNow() })
	return c, 101
}

// greet sends a hello and returns the daemon's reply or the close error.
func greet(c *websocket.Conn, hello Packet) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hello.Type, hello.Protocol = "hello", Protocol
	if err := wsjson.Write(ctx, c, hello); err != nil {
		return err
	}
	var reply Packet
	if err := wsjson.Read(ctx, c, &reply); err != nil {
		return err
	}
	if reply.Type != "hello" {
		return fmt.Errorf("unexpected reply %+v", reply)
	}
	return nil
}

// connect attaches a fake extension that answers every request with the
// browser name and records the commands it receives.
func connect(t *testing.T, s *Server, server *httptest.Server, origin string, hello Packet) (*websocket.Conn, <-chan Command) {
	t.Helper()
	c, code := dial(t, s, server, origin)
	if c == nil {
		t.Fatalf("dial %s: HTTP %d", origin, code)
	}
	if err := greet(c, hello); err != nil {
		t.Fatal(err)
	}
	browser := originBrowser(origin)
	got := make(chan Command, 512)
	go func() {
		ctx := context.Background()
		for {
			var p Packet
			if wsjson.Read(ctx, c, &p) != nil {
				return
			}
			if p.Type != "request" {
				continue
			}
			select {
			case got <- *p.Command:
			default:
			}
			reply := Packet{Type: "response", ID: p.ID}
			switch p.Command.Action {
			case "save_as_pdf":
				reply.Error = &Fault{"unsupported", "save_as_pdf is not available in Firefox"}
			case "fail":
				reply.Error = &Fault{"browser_error", "failed"}
			case "list_targets":
				reply.Result = json.RawMessage(`[]`)
			default:
				reply.Result, _ = json.Marshal(map[string]string{"browser": browser})
			}
			if wsjson.Write(ctx, c, reply) != nil {
				return
			}
		}
	}()
	return c, got
}

func disconnect(t *testing.T, s *Server, c *websocket.Conn, browser string) {
	t.Helper()
	c.CloseNow()
	deadline := time.Now().Add(5 * time.Second)
	for s.Hub.ConnectedTo(browser) {
		if time.Now().After(deadline) {
			t.Fatalf("%s still connected", browser)
		}
		time.Sleep(time.Millisecond)
	}
}

func post(t *testing.T, s *Server, server *httptest.Server, cmd map[string]any) (int, Reply) {
	t.Helper()
	body, _ := json.Marshal(cmd)
	req, _ := http.NewRequest("POST", server.URL+"/command", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+s.Config.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var reply Reply
	if err = json.NewDecoder(res.Body).Decode(&reply); err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, reply
}

// routed sends a command and returns the browser that answered it.
func routed(t *testing.T, s *Server, server *httptest.Server, session, browser string) string {
	t.Helper()
	cmd := map[string]any{"session": session, "action": "echo"}
	if browser != "" {
		cmd["browser"] = browser
	}
	code, reply := post(t, s, server, cmd)
	if code != 200 {
		t.Fatalf("%s via %q: HTTP %d %+v", session, browser, code, reply.Error)
	}
	var out struct {
		Browser string `json:"browser"`
	}
	if err := json.Unmarshal(reply.Result, &out); err != nil {
		t.Fatal(err)
	}
	return out.Browser
}

func fails(t *testing.T, s *Server, server *httptest.Server, cmd map[string]any, status int, code string) Reply {
	t.Helper()
	got, reply := post(t, s, server, cmd)
	if got != status || reply.Error == nil || reply.Error.Code != code {
		t.Fatalf("%v: got HTTP %d %+v, want %d %s", cmd, got, reply.Error, status, code)
	}
	return reply
}

func TestExtensionOrigins(t *testing.T) {
	s, server := newServer(t, config.Config{})
	for _, origin := range []string{
		"https://evil.test",
		"moz-extension://not-a-uuid",
		"moz-extension://0C0FFEE0-0000-4000-8000-000000000001",
		"moz-extension://0c0ffee0-0000-4000-8000-000000000001/",
		"moz-extension://0c0ffee0-0000-4000-8000-000000000001.evil.test",
		"moz-extension://0c0ffee000004000800000000000001",
		"chrome-extension://" + strings.Repeat("z", 32),
		"chrome-extension://" + strings.Repeat("a", 31),
	} {
		if _, code := dial(t, s, server, origin); code != 403 {
			t.Errorf("%s: got HTTP %d, want 403", origin, code)
		}
	}
	// Extension origins are accepted only on the extension endpoint.
	req, _ := http.NewRequest("GET", server.URL+"/status", nil)
	req.Header.Set("Authorization", "Bearer "+s.Config.Token)
	req.Header.Set("Origin", firefoxExtension)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("extension origin on /status: %d", res.StatusCode)
	}
	connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	connect(t, s, server, chromeExtension, Packet{})
	if !s.Hub.ConnectedTo(Chrome) || !s.Hub.ConnectedTo(Firefox) {
		t.Fatal("extension origins were not attached")
	}
}

func TestHelloMustMatchOriginAndBounds(t *testing.T) {
	s, server := newServer(t, config.Config{})
	tooMany := make([]string, MaxSessions+1)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("s%d", i)
	}
	cases := []struct {
		name   string
		origin string
		hello  Packet
	}{
		{"firefox origin without browser", firefoxExtension, Packet{}},
		{"firefox origin claiming chrome", firefoxExtension, Packet{Browser: Chrome}},
		{"chrome origin claiming firefox", chromeExtension, Packet{Browser: Firefox}},
		{"unknown browser", chromeExtension, Packet{Browser: "safari"}},
		{"long version", firefoxExtension, Packet{Browser: Firefox, BrowserVersion: strings.Repeat("1", 129)}},
		{"too many sessions", firefoxExtension, Packet{Browser: Firefox, Sessions: tooMany}},
		{"invalid session", chromeExtension, Packet{Browser: Chrome, Sessions: []string{"ok", "bad name"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, code := dial(t, s, server, tc.origin)
			if c == nil {
				t.Fatalf("dial: HTTP %d", code)
			}
			if err := greet(c, tc.hello); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
				t.Fatalf("hello accepted or closed differently: %v", err)
			}
			if s.Hub.Connected() {
				t.Fatal("rejected hello attached a browser")
			}
		})
	}
}

// A hello at checkHello's bounds connects. 128 names of 96 Chinese characters
// exceed the 32 KiB default read limit of coder/websocket; names of 4-byte
// letters with the longest browserVersion make the largest hello.
func TestHelloAtItsBoundsConnects(t *testing.T) {
	names := func(first rune) []string {
		out := make([]string, MaxSessions)
		for i := range out {
			out[i] = strings.Repeat(string(first), 95) + string(first+rune(i))
		}
		return out
	}
	cases := []struct {
		name  string
		hello Packet
	}{
		{"Chinese names", Packet{Browser: Firefox, BrowserVersion: "159.0", Sessions: names('会')}},
		{"4-byte names and the longest version", Packet{Browser: Firefox, BrowserVersion: strings.Repeat("1", 128), Sessions: names(0x20000)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, server := newServer(t, config.Config{})
			hello := tc.hello
			hello.Type, hello.Protocol = "hello", Protocol
			wire, _ := json.Marshal(hello)
			if reason := checkHello(hello, Firefox); reason != "" || len(wire) <= 32<<10 {
				t.Fatalf("hello of %d bytes, checkHello %q: want an accepted hello above 32 KiB", len(wire), reason)
			}
			connect(t, s, server, firefoxExtension, tc.hello)
			s.Hub.mu.Lock()
			bound := s.Hub.count(Firefox)
			s.Hub.mu.Unlock()
			if bound != MaxSessions {
				t.Fatalf("hello bound %d sessions, want %d", bound, MaxSessions)
			}
		})
	}
}

func TestBrowsersCoexistAndSameBrowserIsRefused(t *testing.T) {
	s, server := newServer(t, config.Config{})
	chrome, _ := connect(t, s, server, chromeExtension, Packet{Browser: Chrome, BrowserVersion: "156.0.8078.80"})
	firefox, _ := connect(t, s, server, firefoxExtension, Packet{Browser: Firefox, BrowserVersion: "159.0"})
	for _, origin := range []string{chromeExtension, "chrome-extension://" + strings.Repeat("b", 32), firefoxExtension, "moz-extension://0c0ffee0-0000-4000-8000-000000000002"} {
		if c, code := dial(t, s, server, origin); c != nil || code != 409 {
			t.Errorf("second %s connection: HTTP %d, want 409", origin, code)
		}
	}
	status := func() map[string]json.RawMessage {
		req, _ := http.NewRequest("GET", server.URL+"/status", nil)
		req.Header.Set("Authorization", "Bearer "+s.Config.Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]json.RawMessage
		if err = json.NewDecoder(res.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	got := status()
	if string(got["extension_connected"]) != "true" || string(got["browsers"]) != `[{"browser":"chrome","browserVersion":"156.0.8078.80","connected":true},{"browser":"firefox","browserVersion":"159.0","connected":true}]` {
		t.Fatalf("status: %s %s", got["extension_connected"], got["browsers"])
	}
	disconnect(t, s, firefox, Firefox)
	if got = status(); string(got["browsers"]) != `[{"browser":"chrome","browserVersion":"156.0.8078.80","connected":true}]` {
		t.Fatalf("status after Firefox left: %s", got["browsers"])
	}
	connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	disconnect(t, s, chrome, Chrome)
	if got = status(); string(got["extension_connected"]) != "true" || string(got["browsers"]) != `[{"browser":"firefox","connected":true}]` {
		t.Fatalf("status with Firefox only: %s %s", got["extension_connected"], got["browsers"])
	}
}

// The hello reply is the point from which a browser is routable: once the
// extension has read it, the daemon reports the browser connected and sends it
// commands, without waiting.
func TestBrowserIsRoutableOnceItReadsTheHelloReply(t *testing.T) {
	s, server := newServer(t, config.Config{})
	for round := range 20 {
		for _, origin := range []string{chromeExtension, firefoxExtension} {
			browser := originBrowser(origin)
			c, _ := connect(t, s, server, origin, Packet{Browser: browser, Sessions: []string{}})
			if !s.Hub.ConnectedTo(browser) {
				t.Fatalf("round %d: %s read the hello reply but is not connected", round, browser)
			}
			if got := routed(t, s, server, fmt.Sprintf("%s-%d", browser, round), browser); got != browser {
				t.Fatalf("round %d: %s command answered by %s", round, browser, got)
			}
			disconnect(t, s, c, browser)
		}
	}
}

func TestSessionRouting(t *testing.T) {
	s, server := newServer(t, config.Config{})
	fails(t, s, server, map[string]any{"session": "none", "action": "echo"}, 503, "browser_offline")
	fails(t, s, server, map[string]any{"session": "none", "action": "echo", "browser": "safari"}, 400, "invalid_request")
	firefox, _ := connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	// Rule 2: the only connected browser serves an unbound session and binds it.
	if got := routed(t, s, server, "fx-first", ""); got != Firefox {
		t.Fatalf("single browser: %s", got)
	}
	reply := fails(t, s, server, map[string]any{"session": "fx-only", "action": "echo", "browser": "chrome"}, 503, "browser_offline")
	if !strings.Contains(reply.Error.Message, "chrome") {
		t.Fatalf("offline message names no browser: %s", reply.Error.Message)
	}
	connect(t, s, server, chromeExtension, Packet{Browser: Chrome})
	// Rule 2: Chrome serves unbound sessions when both are connected; bindings persist.
	if got := routed(t, s, server, "fx-first", ""); got != Firefox {
		t.Fatalf("binding ignored after Chrome connected: %s", got)
	}
	if got := routed(t, s, server, "both", ""); got != Chrome {
		t.Fatalf("default with both: %s", got)
	}
	// Rule 1: an explicit browser binds an unbound session and must match a bound one.
	if got := routed(t, s, server, "explicit", Firefox); got != Firefox {
		t.Fatalf("explicit: %s", got)
	}
	if got := routed(t, s, server, "explicit", ""); got != Firefox {
		t.Fatalf("explicit binding: %s", got)
	}
	if got := routed(t, s, server, "explicit", Firefox); got != Firefox {
		t.Fatalf("matching explicit browser: %s", got)
	}
	fails(t, s, server, map[string]any{"session": "explicit", "action": "echo", "browser": "chrome"}, 409, "session_browser")
	fails(t, s, server, map[string]any{"session": "both", "action": "echo", "browser": "firefox"}, 409, "session_browser")
	// Rule 3: a bound session whose browser is gone is offline, never rerouted.
	disconnect(t, s, firefox, Firefox)
	reply = fails(t, s, server, map[string]any{"session": "explicit", "action": "echo"}, 503, "browser_offline")
	if !strings.Contains(reply.Error.Message, "firefox") {
		t.Fatalf("offline message names no browser: %s", reply.Error.Message)
	}
	// Rule 5: a disconnect keeps bindings; an extension without a session list keeps them too.
	connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	if got := routed(t, s, server, "explicit", ""); got != Firefox {
		t.Fatalf("binding lost across reconnect: %s", got)
	}
	// Rule 5: only a successful close_session removes the binding.
	fails(t, s, server, map[string]any{"session": "explicit", "action": "fail"}, 502, "browser_error")
	fails(t, s, server, map[string]any{"session": "explicit", "action": "echo", "browser": "chrome"}, 409, "session_browser")
	if code, _ := post(t, s, server, map[string]any{"session": "explicit", "action": "close_session"}); code != 200 {
		t.Fatalf("close_session: %d", code)
	}
	if got := routed(t, s, server, "explicit", Chrome); got != Chrome {
		t.Fatalf("closed session kept its binding: %s", got)
	}
}

// Rule 2 holds while another command binds the session: a command without
// browser that races a command with browser firefox on a new session is
// answered by one of the browsers, or is busy when the binding came between
// its resolution and dispatch, and never gets session_browser.
func TestCommandWithoutBrowserNeverGetsSessionBrowser(t *testing.T) {
	s, server := newServer(t, config.Config{})
	connect(t, s, server, chromeExtension, Packet{Browser: Chrome})
	connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	send := func(cmd map[string]any) (int, Reply, error) {
		body, _ := json.Marshal(cmd)
		req, _ := http.NewRequest("POST", server.URL+"/command", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+s.Config.Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0, Reply{}, err
		}
		defer res.Body.Close()
		var reply Reply
		err = json.NewDecoder(res.Body).Decode(&reply)
		return res.StatusCode, reply, err
	}
	for i := range 500 {
		session := fmt.Sprintf("race-%d", i)
		start := make(chan struct{})
		var plain, explicit struct {
			code  int
			reply Reply
			err   error
		}
		var both sync.WaitGroup
		both.Go(func() {
			<-start
			plain.code, plain.reply, plain.err = send(map[string]any{"session": session, "action": "echo"})
		})
		both.Go(func() {
			<-start
			explicit.code, explicit.reply, explicit.err = send(map[string]any{"session": session, "action": "echo", "browser": Firefox})
		})
		close(start)
		both.Wait()
		if plain.err != nil || explicit.err != nil {
			t.Fatalf("%s: %v / %v", session, plain.err, explicit.err)
		}
		switch e := plain.reply.Error; {
		case e == nil && plain.code == 200:
		case e != nil && e.Code == "busy" && strings.Contains(e.Message, "was just bound to firefox"):
		default:
			t.Fatalf("%s without browser: HTTP %d %+v", session, plain.code, e)
		}
		if e := explicit.reply.Error; explicit.code != 200 && (e == nil || e.Code != "session_browser") {
			t.Fatalf("%s with browser firefox: HTTP %d %+v", session, explicit.code, e)
		}
		// close_session unbinds the session, so the bindings stay below 128.
		if code, reply := post(t, s, server, map[string]any{"session": session, "action": "close_session"}); code != 200 {
			t.Fatalf("%s close_session: HTTP %d %+v", session, code, reply.Error)
		}
	}
}

// CallResolved sends a command only to the browser it was resolved to. When
// the session's route moves to the other browser before dispatch, it returns
// busy without sending or binding, and a retry follows the new route.
func TestResolvedCommandIsBusyWhenItsRouteMoves(t *testing.T) {
	s, server := newServer(t, config.Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, firefoxSeen := connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	busy := func(err error, want string) {
		t.Helper()
		if e := fault(err); e.Code != "busy" || !strings.Contains(e.Message, want) {
			t.Fatalf("got %v, want busy with %q", err, want)
		}
	}
	// Only Firefox is connected when the unbound session is resolved; Chrome
	// then connects and takes unbound sessions.
	if got, err := s.Hub.Resolve("moved", ""); err != nil || got != Firefox {
		t.Fatalf("resolved to %q %v", got, err)
	}
	_, chromeSeen := connect(t, s, server, chromeExtension, Packet{Browser: Chrome})
	_, err := s.Hub.CallResolved(ctx, Firefox, Command{Session: "moved", Action: "echo"})
	busy(err, "or the connected browsers changed")
	s.Hub.mu.Lock()
	bound := s.Hub.bindings["moved"]
	s.Hub.mu.Unlock()
	if bound != "" {
		t.Fatalf("a busy command bound the session to %s", bound)
	}
	// Resolved to Chrome, then another command binds the session to Firefox.
	if got, err := s.Hub.Resolve("moved", ""); err != nil || got != Chrome {
		t.Fatalf("resolved to %q %v", got, err)
	}
	if _, err = s.Hub.Call(ctx, Command{Session: "moved", Browser: Firefox, Action: "echo"}); err != nil {
		t.Fatal(err)
	}
	if cmd := <-firefoxSeen; cmd.Session != "moved" || cmd.Browser != Firefox {
		t.Fatalf("Firefox received %+v first, want the command with browser firefox", cmd)
	}
	_, err = s.Hub.CallResolved(ctx, Chrome, Command{Session: "moved", Action: "echo"})
	busy(err, "session moved was just bound to firefox")
	// The retry resolves the binding and reaches Firefox.
	got, err := s.Hub.Resolve("moved", "")
	if err != nil || got != Firefox {
		t.Fatalf("retry resolved to %q %v", got, err)
	}
	if out, err := s.Hub.CallResolved(ctx, got, Command{Session: "moved", Action: "echo"}); err != nil || string(out) != `{"browser":"firefox"}` {
		t.Fatalf("retry: %s %v", out, err)
	}
	// A command with browser still gets session_browser (rule 1).
	if _, err = s.Hub.CallResolved(ctx, Chrome, Command{Session: "moved", Browser: Chrome, Action: "echo"}); fault(err).Code != "session_browser" {
		t.Fatalf("explicit Chrome command: %v", err)
	}
	select {
	case cmd := <-chromeSeen:
		t.Fatalf("Chrome received %+v", cmd)
	default:
	}
}

// A command resolved to its session's binding finds the binding removed by a
// close_session that completed first, while both browsers stay connected.
func TestResolvedCommandIsBusyWhenItsBindingIsRemoved(t *testing.T) {
	s, server := newServer(t, config.Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, chromeSeen := connect(t, s, server, chromeExtension, Packet{Browser: Chrome})
	connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	if got := routed(t, s, server, "task", Firefox); got != Firefox {
		t.Fatalf("task ran in %s", got)
	}
	resolved, err := s.Hub.Resolve("task", "")
	if err != nil || resolved != Firefox {
		t.Fatalf("resolved to %q %v", resolved, err)
	}
	if _, err = s.Hub.Call(ctx, Command{Session: "task", Action: "close_session"}); err != nil {
		t.Fatal(err)
	}
	_, err = s.Hub.CallResolved(ctx, resolved, Command{Session: "task", Action: "echo"})
	if e := fault(err); e.Code != "busy" || !strings.Contains(e.Message, "close_session or the extension's hello removed its binding") {
		t.Fatalf("got %v, want busy naming the removed binding", err)
	}
	select {
	case cmd := <-chromeSeen:
		t.Fatalf("Chrome received %+v", cmd)
	default:
	}
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}
func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestHelloSessionsRestoreBindings(t *testing.T) {
	logs := &lockedBuffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	s, server := newServer(t, config.Config{})
	// Rule 4: after a daemon restart the extensions' hello rebuilds the bindings.
	connect(t, s, server, chromeExtension, Packet{Browser: Chrome, Sessions: []string{"shared", "cr"}})
	firefox, _ := connect(t, s, server, firefoxExtension, Packet{Browser: Firefox, Sessions: []string{"shared", "fx", "stale"}})
	if got := routed(t, s, server, "fx", ""); got != Firefox {
		t.Fatalf("restored Firefox session: %s", got)
	}
	if got := routed(t, s, server, "cr", ""); got != Chrome {
		t.Fatalf("restored Chrome session: %s", got)
	}
	// The later report does not take over an existing binding; it is logged once.
	if got := routed(t, s, server, "shared", ""); got != Chrome {
		t.Fatalf("conflicting hello rebound a session: %s", got)
	}
	if n := strings.Count(logs.String(), "already bound to another browser"); n != 1 || !strings.Contains(logs.String(), "shared") {
		t.Fatalf("conflict warnings: %q", logs.String())
	}
	// A hello list drops this browser's bindings that the extension no longer holds.
	disconnect(t, s, firefox, Firefox)
	connect(t, s, server, firefoxExtension, Packet{Browser: Firefox, Sessions: []string{"fx"}})
	if got := routed(t, s, server, "stale", ""); got != Chrome {
		t.Fatalf("stale binding survived the session list: %s", got)
	}
	if got := routed(t, s, server, "fx", ""); got != Firefox {
		t.Fatalf("listed binding dropped: %s", got)
	}
	if got := routed(t, s, server, "shared", ""); got != Chrome {
		t.Fatalf("other browser's binding dropped: %s", got)
	}
}

func TestBindingsAreBoundedPerBrowser(t *testing.T) {
	s, server := newServer(t, config.Config{})
	connect(t, s, server, chromeExtension, Packet{Browser: Chrome})
	connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for i := range MaxSessions {
		if _, err := s.Hub.Call(ctx, Command{Session: fmt.Sprintf("c%d", i), Action: "echo"}); err != nil {
			t.Fatal(err)
		}
	}
	reply := fails(t, s, server, map[string]any{"session": "c-over", "action": "echo"}, 429, "busy")
	if !strings.Contains(reply.Error.Message, "chrome") {
		t.Fatalf("busy message: %s", reply.Error.Message)
	}
	// Existing sessions keep working and the other browser has its own budget.
	if got := routed(t, s, server, "c0", ""); got != Chrome {
		t.Fatal(got)
	}
	if got := routed(t, s, server, "f0", Firefox); got != Firefox {
		t.Fatal(got)
	}
	if code, _ := post(t, s, server, map[string]any{"session": "c0", "action": "close_session"}); code != 200 {
		t.Fatal(code)
	}
	if got := routed(t, s, server, "c-over", ""); got != Chrome {
		t.Fatal(got)
	}
}

func TestUnsupportedIs501(t *testing.T) {
	s, server := newServer(t, config.Config{})
	connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	reply := fails(t, s, server, map[string]any{"session": "pdf", "action": "save_as_pdf"}, 501, "unsupported")
	if reply.Error.Message != "save_as_pdf is not available in Firefox" {
		t.Fatal(reply.Error.Message)
	}
}

func get(t *testing.T, s *Server, server *httptest.Server, path string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", server.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+s.Config.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body bytes.Buffer
	_, _ = body.ReadFrom(res.Body)
	return res.StatusCode, body.String()
}

func TestCDPEndpointsNeedChrome(t *testing.T) {
	s, server := newServer(t, config.Config{})
	paths := []string{"/json", "/json/list", "/json/version", "/devtools/page/1", "/devtools/browser"}
	// Without any extension the endpoints that need Chrome answer
	// browser_offline with its /command status.
	for path, want := range map[string]int{"/json/version": 200, "/json/list": 503, "/devtools/page/1": 503, "/devtools/browser": 503} {
		if code, body := get(t, s, server, path); code != want {
			t.Errorf("no browser %s: %d %s", path, code, body)
		}
	}
	firefox, _ := connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	for _, path := range paths {
		code, body := get(t, s, server, path)
		if code != 501 || !strings.Contains(body, `"code":"unsupported"`) {
			t.Errorf("Firefox only %s: %d %s", path, code, body)
		}
	}
	_, chromeSeen := connect(t, s, server, chromeExtension, Packet{Browser: Chrome})
	if code, body := get(t, s, server, "/json/list"); code != 200 || strings.TrimSpace(body) != "[]" {
		t.Fatalf("Chrome targets with both browsers: %d %s", code, body)
	}
	if cmd := <-chromeSeen; cmd.Action != "list_targets" {
		t.Fatalf("CDP transport went elsewhere: %+v", cmd)
	}
	s.Hub.mu.Lock()
	_, bound := s.Hub.bindings["cdp"]
	s.Hub.mu.Unlock()
	if bound {
		t.Fatal("transport-internal session was bound")
	}
	disconnect(t, s, firefox, Firefox)
	// Native CDP mode keeps the browser endpoint with only Firefox connected.
	native, nativeServer := newServer(t, config.Config{CDP: "ws://127.0.0.1:9/devtools/browser/x"})
	connect(t, native, nativeServer, firefoxExtension, Packet{Browser: Firefox})
	if code, body := get(t, native, nativeServer, "/json/version"); code != 200 || !strings.Contains(body, "/devtools/browser") {
		t.Fatalf("native /json/version: %d %s", code, body)
	}
}

// An omitted timeoutMs takes the 30-second default; an explicit one outside
// 1–120000, 0 included, is rejected before the command is sent.
func TestExplicitDeadlineOutsideItsRangeIsRejected(t *testing.T) {
	s, server := newServer(t, config.Config{})
	_, seen := connect(t, s, server, chromeExtension, Packet{Browser: Chrome})
	for _, timeout := range []any{0, -1, 120001, 1.5} {
		reply := fails(t, s, server, map[string]any{"session": "deadline", "action": "echo", "timeoutMs": timeout}, 400, "invalid_request")
		if !strings.Contains(reply.Error.Message, "timeoutMs") {
			t.Errorf("timeoutMs %v: %q does not name the field", timeout, reply.Error.Message)
		}
	}
	for _, tc := range []struct {
		body map[string]any
		want int
	}{
		{map[string]any{"session": "deadline", "action": "echo"}, 30000},
		{map[string]any{"session": "deadline", "action": "echo", "timeoutMs": nil}, 30000},
		{map[string]any{"session": "deadline", "action": "echo", "timeoutMs": 120000}, 120000},
	} {
		if code, reply := post(t, s, server, tc.body); code != 200 {
			t.Fatalf("%v: HTTP %d %+v", tc.body, code, reply.Error)
		}
		if cmd := <-seen; cmd.TimeoutMS != tc.want {
			t.Fatalf("%v: forwarded timeoutMs %d, want %d", tc.body, cmd.TimeoutMS, tc.want)
		}
	}
}

// Each browser connection has its own command slots and recovery reserve, and
// a daemon cleanup goes to the browser that serves its session.
func TestEachBrowserConnectionHasItsOwnCommandSlots(t *testing.T) {
	s, server := newServer(t, config.Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// The Chrome stand-in records every request and answers none of them.
	chrome, code := dial(t, s, server, chromeExtension)
	if chrome == nil {
		t.Fatalf("dial Chrome: HTTP %d", code)
	}
	if err := greet(chrome, Packet{Browser: Chrome}); err != nil {
		t.Fatal(err)
	}
	received := make(chan Command, 256)
	go func() {
		for {
			var p Packet
			if wsjson.Read(ctx, chrome, &p) != nil {
				return
			}
			if p.Type == "request" {
				received <- *p.Command
			}
		}
	}()
	_, firefoxSeen := connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	forwarded := func(want string) {
		t.Helper()
		select {
		case cmd := <-received:
			if cmd.Action != want {
				t.Fatalf("Chrome received %s, want %s", cmd.Action, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s was not forwarded to Chrome", want)
		}
	}
	var hung sync.WaitGroup
	defer hung.Wait()
	defer cancel()
	hold := func(browser string, cmd Command) {
		hung.Go(func() {
			if browser == "" {
				_, _ = s.Hub.Call(ctx, cmd)
			} else {
				_, _ = s.Hub.Cleanup(ctx, browser, cmd)
			}
		})
	}
	// Unbound sessions go to Chrome while both browsers are connected.
	for i := range maxPending {
		hold("", Command{Session: fmt.Sprintf("hung-%d", i%4), Action: "snapshot"})
	}
	for range maxPending {
		forwarded("snapshot")
	}
	if _, err := s.Hub.Call(ctx, Command{Session: "hung-0", Action: "snapshot"}); err == nil || fault(err).Code != "busy" {
		t.Fatalf("ordinary Chrome command over capacity: %v", err)
	}
	out, err := s.Hub.Call(ctx, Command{Session: "fx", Browser: Firefox, Action: "snapshot"})
	if err != nil || string(out) != `{"browser":"firefox"}` {
		t.Fatalf("Firefox command while Chrome is full: %s %v", out, err)
	}
	if cmd := <-firefoxSeen; cmd.Action != "snapshot" || cmd.Session != "fx" {
		t.Fatalf("Firefox received %+v, want snapshot for fx", cmd)
	}
	// The stream cleanup of a Firefox session goes to Firefox.
	if _, err = s.Hub.Cleanup(ctx, "", Command{Session: "fx", Action: "artifact_close", Args: json.RawMessage(`{"handle":"h"}`)}); err != nil {
		t.Fatal(err)
	}
	if cmd := <-firefoxSeen; cmd.Action != "artifact_close" || cmd.Session != "fx" {
		t.Fatalf("Firefox received %+v, want artifact_close for fx", cmd)
	}
	// Chrome's reserve still takes recovery and the page CDP cleanup.
	hold("", Command{Session: "hung-1", Action: "close_session"})
	forwarded("close_session")
	page := pageClientSession()
	hold(Chrome, Command{Session: page, Action: "cdp_detach", Args: json.RawMessage(`{"tabId":7}`)})
	forwarded("cdp_detach")
	s.Hub.mu.Lock()
	fx, pageBrowser := s.Hub.bindings["fx"], s.Hub.bindings[page]
	s.Hub.mu.Unlock()
	if fx != Firefox || pageBrowser != "" {
		t.Fatalf("bindings fx=%q %s=%q; cleanups bind no session", fx, page, pageBrowser)
	}
}

// HTTP ordinary slots belong to the resolved browser: while Chrome holds 128
// waiting commands its next ordinary command is busy, and Firefox commands are
// still forwarded. A command whose browser cannot be resolved fails as before.
func TestEachBrowserHasItsOwnHTTPCommandSlots(t *testing.T) {
	s, server := newServer(t, config.Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// The Chrome stand-in records every request and answers none of them.
	chrome, code := dial(t, s, server, chromeExtension)
	if chrome == nil {
		t.Fatalf("dial Chrome: HTTP %d", code)
	}
	if err := greet(chrome, Packet{Browser: Chrome}); err != nil {
		t.Fatal(err)
	}
	received := make(chan Command, 256)
	go func() {
		for {
			var p Packet
			if wsjson.Read(ctx, chrome, &p) != nil {
				return
			}
			if p.Type == "request" {
				received <- *p.Command
			}
		}
	}()
	_, firefoxSeen := connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	forwarded := func(want string) {
		t.Helper()
		select {
		case cmd := <-received:
			if cmd.Action != want {
				t.Fatalf("Chrome received %s, want %s", cmd.Action, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s was not forwarded to Chrome", want)
		}
	}
	var hung sync.WaitGroup
	defer hung.Wait()
	defer cancel()
	hold := func(session, action string) {
		hung.Go(func() {
			body := fmt.Sprintf(`{"session":%q,"action":%q}`, session, action)
			req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/command", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+s.Config.Token)
			if res, err := http.DefaultClient.Do(req); err == nil {
				res.Body.Close()
			}
		})
	}
	// Unbound sessions go to Chrome while both browsers are connected.
	for i := range maxPending {
		hold(fmt.Sprintf("hung-%d", i%4), "snapshot")
	}
	for range maxPending {
		forwarded("snapshot")
	}
	fails(t, s, server, map[string]any{"session": "hung-0", "action": "snapshot"}, 429, "busy")
	fails(t, s, server, map[string]any{"session": "new", "action": "snapshot"}, 429, "busy")
	if got := routed(t, s, server, "fx", Firefox); got != Firefox {
		t.Fatalf("Firefox command answered by %q", got)
	}
	if cmd := <-firefoxSeen; cmd.Action != "echo" || cmd.Session != "fx" {
		t.Fatalf("Firefox received %+v, want echo for fx", cmd)
	}
	if got := routed(t, s, server, "fx", ""); got != Firefox {
		t.Fatalf("bound Firefox session answered by %q", got)
	}
	<-firefoxSeen
	// Routing errors come before capacity.
	fails(t, s, server, map[string]any{"session": "fx", "browser": Chrome, "action": "snapshot"}, 409, "session_browser")
	// close_session and dialog take no ordinary slot.
	hold("hung-1", "close_session")
	forwarded("close_session")
	hold("hung-2", "dialog")
	forwarded("dialog")
}

func TestFirefoxUploadSendsFileBytes(t *testing.T) {
	s, server := newServer(t, config.Config{})
	_, chromeSeen := connect(t, s, server, chromeExtension, Packet{Browser: Chrome})
	_, firefoxSeen := connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	dir := t.TempDir()
	write := func(name string, data []byte) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	photo := write("photo.png", []byte{0x89, 'P', 'N', 'G'})
	data := write("data.json", []byte(`{"ok":true}`))
	blob := write("blob.omwbin", []byte("raw"))
	upload := map[string]any{"selector": "#file", "files": []string{photo, data, blob}}
	if got := routed(t, s, server, "page", ""); got != Chrome {
		t.Fatal(got)
	}
	<-chromeSeen
	if code, reply := post(t, s, server, map[string]any{"session": "page", "action": "upload", "args": upload}); code != 200 {
		t.Fatalf("chrome upload: %d %+v", code, reply.Error)
	}
	if cmd := <-chromeSeen; string(cmd.Args) != fmt.Sprintf(`{"files":[%q,%q,%q],"selector":"#file"}`, photo, data, blob) {
		t.Fatalf("Chrome upload changed: %s", cmd.Args)
	}
	if code, reply := post(t, s, server, map[string]any{"session": "fx", "browser": "firefox", "action": "upload", "args": upload}); code != 200 {
		t.Fatalf("firefox upload: %d %+v", code, reply.Error)
	}
	want := []uploadFile{
		{"photo.png", "image/png", base64.StdEncoding.EncodeToString([]byte{0x89, 'P', 'N', 'G'})},
		{"data.json", "application/json", base64.StdEncoding.EncodeToString([]byte(`{"ok":true}`))},
		{"blob.omwbin", "", base64.StdEncoding.EncodeToString([]byte("raw"))},
	}
	var inlined struct {
		Selector string       `json:"selector"`
		Files    []uploadFile `json:"files"`
	}
	cmd := <-firefoxSeen
	if err := json.Unmarshal(cmd.Args, &inlined); err != nil || inlined.Selector != "#file" || fmt.Sprint(inlined.Files) != fmt.Sprint(want) {
		t.Fatalf("Firefox upload: %s %v", cmd.Args, err)
	}
	// Bound sessions route to Firefox without an explicit browser; batch steps are rewritten.
	batch := map[string]any{"steps": []map[string]any{
		{"action": "click", "args": map[string]any{"selector": "#open"}},
		{"action": "upload", "args": map[string]any{"selector": "#file", "files": []string{blob}}},
	}}
	if code, reply := post(t, s, server, map[string]any{"session": "fx", "action": "batch", "args": batch}); code != 200 {
		t.Fatalf("firefox batch: %d %+v", code, reply.Error)
	}
	var steps struct {
		Steps []struct {
			Action string          `json:"action"`
			Args   json.RawMessage `json:"args"`
		} `json:"steps"`
	}
	cmd = <-firefoxSeen
	if err := json.Unmarshal(cmd.Args, &steps); err != nil || len(steps.Steps) != 2 || string(steps.Steps[0].Args) != `{"selector":"#open"}` || !strings.Contains(string(steps.Steps[1].Args), `"data":"cmF3"`) {
		t.Fatalf("Firefox batch: %s %v", cmd.Args, err)
	}
}

func TestFirefoxUploadRejectsUnreadableFiles(t *testing.T) {
	s, server := newServer(t, config.Config{})
	_, firefoxSeen := connect(t, s, server, firefoxExtension, Packet{Browser: Firefox})
	dir := t.TempDir()
	fifo := filepath.Join(dir, "pipe")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	sparse := func(name string, size int64) string {
		path := filepath.Join(dir, name)
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if err = f.Truncate(size); err != nil {
			t.Fatal(err)
		}
		return path
	}
	huge := sparse("huge.bin", MaxUpload+1)
	first := sparse("first.bin", 10<<20)
	second := sparse("second.bin", 7<<20)
	missing := filepath.Join(dir, "missing.txt")
	cases := []struct {
		name    string
		action  string
		args    any
		message string
	}{
		{"relative", "upload", map[string]any{"files": []string{"relative.txt"}}, "relative.txt"},
		{"directory", "upload", map[string]any{"files": []string{dir}}, dir},
		{"fifo", "upload", map[string]any{"files": []string{fifo}}, fifo},
		{"missing", "upload", map[string]any{"files": []string{missing}}, missing},
		{"one file over the limit", "upload", map[string]any{"files": []string{huge}}, huge},
		{"total over the limit", "upload", map[string]any{"files": []string{first, second}}, second},
		{"files not an array", "upload", map[string]any{"files": first}, "array"},
		{"files missing", "upload", map[string]any{"selector": "#file"}, "array"},
		{"batch step", "batch", map[string]any{"steps": []map[string]any{{"action": "click"}, {"action": "upload", "args": map[string]any{"files": []string{missing}}}}}, "batch step 1: read upload file " + missing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reply := fails(t, s, server, map[string]any{"session": "fx", "browser": "firefox", "action": tc.action, "args": tc.args}, 400, "invalid_args")
			if !strings.Contains(reply.Error.Message, tc.message) {
				t.Fatalf("message %q lacks %q", reply.Error.Message, tc.message)
			}
		})
	}
	select {
	case cmd := <-firefoxSeen:
		t.Fatalf("rejected upload reached the extension: %+v", cmd)
	default:
	}
}

// Firefox uploads in flight share one byte budget. A command that does not fit
// gets busy, and a command gives its bytes back however it returns. The test
// waits only for events: requests reaching the extension and replies.
func TestFirefoxUploadsShareTheBudget(t *testing.T) {
	s, server := newServer(t, config.Config{})
	c, code := dial(t, s, server, firefoxExtension)
	if c == nil {
		t.Fatalf("dial: HTTP %d", code)
	}
	if err := greet(c, Packet{Browser: Firefox}); err != nil {
		t.Fatal(err)
	}
	// The extension stand-in rejects session "rejected", answers the "held-"
	// sessions once release is closed, never answers "dropped" and answers any
	// other session at once.
	release := make(chan struct{})
	seen := make(chan string, 16)
	go func() {
		ctx := context.Background()
		for {
			var p Packet
			if wsjson.Read(ctx, c, &p) != nil {
				return
			}
			if p.Type != "request" {
				continue
			}
			session := p.Command.Session
			seen <- session
			switch {
			case session == "rejected":
				_ = wsjson.Write(ctx, c, Packet{Type: "response", ID: p.ID, Error: &Fault{"browser_error", "rejected"}})
			case strings.HasPrefix(session, "held-"):
				go func() {
					<-release
					_ = wsjson.Write(ctx, c, Packet{Type: "response", ID: p.ID, Result: json.RawMessage(`{}`)})
				}()
			case session != "dropped":
				_ = wsjson.Write(ctx, c, Packet{Type: "response", ID: p.ID, Result: json.RawMessage(`{}`)})
			}
		}
	}()
	// arrive returns once every named session has reached the extension.
	arrive := func(names ...string) {
		want := map[string]bool{}
		for _, name := range names {
			want[name] = true
		}
		for len(want) > 0 {
			delete(want, <-seen)
		}
	}
	// A small reply reaches the client only after the handler has returned and
	// its deferred release has run, so the budget can be read right after one.
	holds := func(want int64, label string) {
		t.Helper()
		s.uploads.mu.Lock()
		got := s.uploads.used
		s.uploads.mu.Unlock()
		if got != want {
			t.Fatalf("%s: the budget holds %d bytes, want %d", label, got, want)
		}
	}
	const size = 1 << 10
	dir := t.TempDir()
	file := filepath.Join(dir, "file.bin")
	if err := os.WriteFile(file, make([]byte, size), 0600); err != nil {
		t.Fatal(err)
	}
	// The rest of the budget is reserved directly. It stands for other uploads
	// in flight, so four held uploads of size bytes fill the budget.
	others := int64(UploadBudget - 4*size)
	if err := s.uploads.reserve(others); err != nil {
		t.Fatal(err)
	}
	upload := func(session string, files ...string) map[string]any {
		return map[string]any{"session": session, "browser": "firefox", "action": "upload", "timeoutMs": 120000, "args": map[string]any{"selector": "#file", "files": files}}
	}
	// status posts from another goroutine and returns the HTTP status.
	status := func(cmd map[string]any) int {
		body, _ := json.Marshal(cmd)
		req, _ := http.NewRequest("POST", server.URL+"/command", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+s.Config.Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0
		}
		res.Body.Close()
		return res.StatusCode
	}
	// A file that cannot be read and an error from the extension give the
	// bytes back.
	fails(t, s, server, upload("missing", file, filepath.Join(dir, "missing.bin")), 400, "invalid_args")
	holds(others, "after a missing file")
	fails(t, s, server, upload("rejected", file), 502, "browser_error")
	holds(others, "after an extension error")
	// Four held uploads fill the budget; a fifth, alone or in a batch, is busy.
	codes := make(chan int, 4)
	for i := range 4 {
		go func() { codes <- status(upload(fmt.Sprintf("held-%d", i), file)) }()
	}
	arrive("held-0", "held-1", "held-2", "held-3")
	holds(UploadBudget, "with four uploads held")
	reply := fails(t, s, server, upload("over", file), 429, "busy")
	if !strings.Contains(reply.Error.Message, "64 MiB upload budget") {
		t.Fatalf("busy message %q does not name the upload budget", reply.Error.Message)
	}
	fails(t, s, server, map[string]any{"session": "over", "browser": "firefox", "action": "batch", "timeoutMs": 120000, "args": map[string]any{"steps": []map[string]any{{"action": "upload", "args": map[string]any{"files": []string{file}}}}}}, 429, "busy")
	holds(UploadBudget, "after the busy replies")
	// Finished commands give the budget back.
	close(release)
	for range 4 {
		if code := <-codes; code != 200 {
			t.Fatalf("held upload: HTTP %d", code)
		}
	}
	holds(others, "after the held uploads returned")
	// A command cut off by a lost connection gives its bytes back too.
	dropped := make(chan int, 1)
	go func() { dropped <- status(upload("dropped", file)) }()
	arrive("dropped")
	c.CloseNow()
	if code := <-dropped; code != 504 {
		t.Fatalf("upload on a closed connection: HTTP %d", code)
	}
	holds(others, "after the connection closed")
}
