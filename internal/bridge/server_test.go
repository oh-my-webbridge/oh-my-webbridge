package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/oh-my-webbridge/oh-my-webbridge/internal/config"
)

func fixture(t *testing.T) (*Server, *httptest.Server, *websocket.Conn) {
	t.Helper()
	s := New(config.Config{Token: strings.Repeat("a", 64), Dir: t.TempDir()})
	httpServer := httptest.NewServer(s.Handler())
	t.Cleanup(httpServer.Close)
	t.Cleanup(s.Hub.Close)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second*5)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http")+"/extension", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"chrome-extension://" + strings.Repeat("a", 32)}}, Subprotocols: []string{"omw.v1", "omw-token." + s.Config.Token}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	if err = wsjson.Write(ctx, c, Packet{Type: "hello", Protocol: Protocol}); err != nil {
		t.Fatal(err)
	}
	var hello Packet
	if err = wsjson.Read(ctx, c, &hello); err != nil {
		t.Fatal(err)
	}
	for !s.Hub.Connected() {
		select {
		case <-ctx.Done():
			t.Fatal("hub not ready")
		case <-time.After(time.Millisecond):
		}
	}
	return s, httpServer, c
}

func TestAuthenticationAndRequestBoundary(t *testing.T) {
	s, server, _ := fixture(t)
	cases := []struct {
		path, method, body, token, origin, host string
		status                                  int
	}{
		{"/status", "GET", "", "", "", "", 401},
		{"/status", "GET", "", s.Config.Token, "https://evil.test", "", 403},
		{"/status", "GET", "", s.Config.Token, "", "evil.test:17373", 403},
		{"/status", "GET", "", s.Config.Token, "", "", 200},
		{"/json/version/", "GET", "", s.Config.Token, "", "", 200},
		{"/command", "POST", `{"action":"click"}`, s.Config.Token, "", "", 400},
		{"/command", "POST", `{"action":"click","session":"test","typo":true}`, s.Config.Token, "", "", 400},
		{"/command", "POST", `{"action":"click","session":"test"} {}`, s.Config.Token, "", "", 400},
		{"/command", "POST", `{"action":"click","session":"test","timeoutMs":999999}`, s.Config.Token, "", "", 400},
		{"/command", "POST", strings.Repeat("x", (2<<20)+1), s.Config.Token, "", "", 400},
	}
	for _, tc := range cases {
		req, _ := http.NewRequest(tc.method, server.URL+tc.path, strings.NewReader(tc.body))
		if tc.token != "" {
			req.Header.Set("Authorization", "Bearer "+tc.token)
		}
		req.Header.Set("Origin", tc.origin)
		if tc.host != "" {
			req.Host = tc.host
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != tc.status {
			t.Errorf("%s: got %d want %d", tc.path, res.StatusCode, tc.status)
		}
	}
}

func TestMultiplexedResponsesCannotCrossSessions(t *testing.T) {
	s, _, c := fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	const count = 80
	var wg sync.WaitGroup
	for i := range count {
		wg.Add(1)
		go func() {
			defer wg.Done()
			name := fmt.Sprintf("task-%d", i)
			out, err := s.Hub.Call(ctx, Command{ID: "same-client-id", Session: name, Action: "echo"})
			if err != nil {
				t.Error(err)
				return
			}
			if string(out) != `"`+name+`"` {
				t.Errorf("crossed result: %s", out)
			}
		}()
	}
	requests := make([]Packet, count)
	for i := range count {
		if err := wsjson.Read(ctx, c, &requests[i]); err != nil {
			t.Fatal(err)
		}
	}
	for i := count - 1; i >= 0; i-- {
		raw, _ := json.Marshal(requests[i].Command.Session)
		if err := wsjson.Write(ctx, c, Packet{Type: "response", ID: requests[i].ID, Result: raw}); err != nil {
			t.Fatal(err)
		}
		if err := wsjson.Write(ctx, c, Packet{Type: "response", ID: requests[i].ID, Result: raw}); err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()
	if s.Hub.Inflight() != 0 {
		t.Fatal("pending requests leaked")
	}
	s.Hub.mu.Lock()
	buffered := s.Hub.buffered
	s.Hub.mu.Unlock()
	if buffered != 0 {
		t.Fatalf("duplicate replies leaked %d budget bytes", buffered)
	}
}

func TestDeadlineDoesNotReplayAndDisconnectIsUncertain(t *testing.T) {
	s, _, c := fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	errResult := make(chan error, 1)
	go func() { _, err := s.Hub.Call(ctx, Command{Session: "submit", Action: "click"}); errResult <- err }()
	readCtx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	var msg Packet
	if err := wsjson.Read(readCtx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if err := <-errResult; fault(err).Code != "outcome_unknown" {
		t.Fatalf("unsafe timeout: %v", err)
	}
	if err := wsjson.Read(readCtx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Type != "cancel" {
		t.Fatalf("replayed command: %s", msg.Type)
	}
	if s.Hub.Inflight() != 0 {
		t.Fatal("cancel leaked pending request")
	}
	go func() { _, err := s.Hub.Call(readCtx, Command{Session: "submit", Action: "click"}); errResult <- err }()
	if err := wsjson.Read(readCtx, c, &msg); err != nil {
		t.Fatal(err)
	}
	c.CloseNow()
	if err := <-errResult; fault(err).Code != "outcome_unknown" {
		t.Fatalf("unsafe disconnect: %v", err)
	}
}

func TestRecoveryCommandsReachABusyExtension(t *testing.T) {
	_, server, c := fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// The extension stand-in records every request and answers none of them.
	received := make(chan string, 256)
	go func() {
		for {
			var packet Packet
			if wsjson.Read(ctx, c, &packet) != nil {
				return
			}
			if packet.Type == "request" {
				received <- packet.Command.Action
			}
		}
	}()
	post := func(session, action string) (int, Reply) {
		body := fmt.Sprintf(`{"session":%q,"action":%q}`, session, action)
		req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/command", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 64))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0, Reply{}
		}
		defer res.Body.Close()
		var reply Reply
		_ = json.NewDecoder(res.Body).Decode(&reply)
		return res.StatusCode, reply
	}
	var hung sync.WaitGroup
	defer hung.Wait()
	defer c.CloseNow()
	hold := func(session, action string) {
		hung.Go(func() { post(session, action) })
	}
	forwarded := func(want string) {
		t.Helper()
		select {
		case action := <-received:
			if action != want {
				t.Fatalf("forwarded %s, want %s", action, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s was not forwarded to the extension", want)
		}
	}
	for i := range 128 {
		hold(fmt.Sprintf("hung-%d", i%4), "snapshot")
	}
	for range 128 {
		forwarded("snapshot")
	}
	if code, reply := post("hung-0", "snapshot"); code != 429 || reply.Error == nil || reply.Error.Code != "busy" {
		t.Fatalf("ordinary command over capacity: %d %+v", code, reply.Error)
	}
	for i := range 16 {
		action := []string{"close_session", "dialog"}[i%2]
		hold(fmt.Sprintf("hung-%d", i%4), action)
		forwarded(action)
	}
	if code, reply := post("hung-1", "close_session"); code != 429 || reply.Error == nil || reply.Error.Code != "busy" {
		t.Fatalf("recovery command over its reserve: %d %+v", code, reply.Error)
	}
}

func TestCleanupCommandsUseTheRecoveryReserve(t *testing.T) {
	s, server, c := fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// The extension stand-in records every request and answers only cdp_attach.
	received := make(chan string, 256)
	go func() {
		for {
			var packet Packet
			if wsjson.Read(ctx, c, &packet) != nil {
				return
			}
			if packet.Type != "request" {
				continue
			}
			received <- packet.Command.Action
			if packet.Command.Action == "cdp_attach" {
				_ = wsjson.Write(ctx, c, Packet{Type: "response", ID: packet.ID, Result: json.RawMessage(`{"attached":true}`)})
			}
		}
	}()
	forwarded := func(want string) {
		t.Helper()
		select {
		case action := <-received:
			if action != want {
				t.Fatalf("forwarded %s, want %s", action, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s was not forwarded to the extension", want)
		}
	}
	token := strings.Repeat("a", 64)
	page, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/devtools/page/7", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + token}}})
	if err != nil {
		t.Fatal(err)
	}
	forwarded("cdp_attach")
	var hung sync.WaitGroup
	defer hung.Wait()
	defer c.CloseNow()
	for i := range 128 {
		hung.Go(func() {
			body := fmt.Sprintf(`{"session":"hung-%d","action":"snapshot"}`, i%4)
			req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/command", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+token)
			if res, err := http.DefaultClient.Do(req); err == nil {
				res.Body.Close()
			}
		})
	}
	for range 128 {
		forwarded("snapshot")
	}
	// The page CDP client leaves while every ordinary slot is taken; the tab
	// must still be released from its cdp-* session.
	_ = page.Close(websocket.StatusNormalClosure, "")
	forwarded("cdp_detach")
	// A PDF stream whose read finds no ordinary slot is still closed.
	if _, err := s.saveArtifact(ctx, Chrome, Command{Action: "save_as_pdf", Session: "hung-0", Args: json.RawMessage(`{}`)}, json.RawMessage(`{"stream":"pdf-1"}`)); err == nil {
		t.Fatal("artifact_read succeeded without an ordinary slot")
	}
	forwarded("artifact_close")
	// The same transport-internal action sent over HTTP is an ordinary command.
	req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/command", strings.NewReader(`{"session":"hung-0","action":"artifact_close","args":{"handle":"pdf-1"}}`))
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 429 {
		t.Fatalf("HTTP artifact_close over ordinary capacity: %d", res.StatusCode)
	}
}

// The extension can finish a page CDP attach after the daemon stopped waiting
// for it, so the daemon releases the tab as it does when a client disconnects.
func TestPageCDPAttachWithUnknownOutcomeIsReleased(t *testing.T) {
	s, server, c := fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	type seen struct{ kind, id, action, session string }
	received := make(chan seen, 16)
	go func() {
		for {
			var packet Packet
			if wsjson.Read(ctx, c, &packet) != nil {
				return
			}
			item := seen{kind: packet.Type, id: packet.ID}
			if packet.Command != nil {
				item.action, item.session = packet.Command.Action, packet.Command.Session
			}
			received <- item
			// Tab 8 belongs to another session; an attach to tab 7 is never answered.
			var args struct {
				TabID int `json:"tabId"`
			}
			if packet.Type == "request" && packet.Command.Action == "cdp_attach" && json.Unmarshal(packet.Command.Args, &args) == nil && args.TabID == 8 {
				_ = wsjson.Write(ctx, c, Packet{Type: "response", ID: packet.ID, Error: &Fault{"tab_busy", "tab 8 belongs to task"}})
			}
		}
	}()
	next := func() seen {
		t.Helper()
		select {
		case item := <-received:
			return item
		case <-time.After(8 * time.Second):
			t.Fatal("the daemon sent nothing more to the extension")
		}
		return seen{}
	}
	refused := func(tab int) {
		t.Helper()
		_, res, err := websocket.Dial(ctx, fmt.Sprintf("ws%s/devtools/page/%d", strings.TrimPrefix(server.URL, "http"), tab), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Config.Token}}})
		if err == nil || res == nil || res.StatusCode != 409 {
			t.Fatalf("page %d: %v %v, want HTTP 409", tab, res, err)
		}
	}
	// A refused attach has a known outcome and needs no cleanup.
	refused(8)
	if item := next(); item.action != "cdp_attach" {
		t.Fatalf("forwarded %+v, want cdp_attach", item)
	}
	// An attach that outlives its deadline is cancelled, then detached.
	refused(7)
	attach := next()
	if attach.kind != "request" || attach.action != "cdp_attach" {
		t.Fatalf("forwarded %+v, want the second cdp_attach", attach)
	}
	if item := next(); item.kind != "cancel" || item.id != attach.id {
		t.Fatalf("forwarded %+v, want cancel %s", item, attach.id)
	}
	if item := next(); item.action != "cdp_detach" || item.session != attach.session {
		t.Fatalf("forwarded %+v, want cdp_detach for %s", item, attach.session)
	}
}

// pageClientFixture is an extension that accepts page CDP attaches and
// forwards every packet the daemon sends it.
func pageClientFixture(ctx context.Context, c *websocket.Conn) <-chan Packet {
	received := make(chan Packet, 16)
	go func() {
		for {
			var packet Packet
			if wsjson.Read(ctx, c, &packet) != nil {
				return
			}
			received <- packet
			if packet.Type == "request" && packet.Command.Action == "cdp_attach" {
				_ = wsjson.Write(ctx, c, Packet{Type: "response", ID: packet.ID, Result: json.RawMessage(`{"attached":true}`)})
			}
		}
	}()
	return received
}

// Chrome's own page endpoint closes the connection when its target goes away.
// The daemon does the same after forwarding the page's Inspector.detached, so
// the extension session ends without waiting for the client to disconnect.
func TestPageCDPConnectionEndsWithItsTarget(t *testing.T) {
	s, server, c := fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	received := pageClientFixture(ctx, c)
	next := func() Packet {
		t.Helper()
		select {
		case packet := <-received:
			return packet
		case <-time.After(3 * time.Second):
			t.Fatal("the daemon sent nothing more to the extension")
		}
		return Packet{}
	}
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/devtools/page/7", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Config.Token}}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseNow()
	attach := next()
	if attach.Command == nil || attach.Command.Action != "cdp_attach" {
		t.Fatalf("forwarded %+v, want cdp_attach", attach)
	}
	// A child target's detach keeps the page connection; the page's own ends it.
	for _, event := range []Packet{
		{Type: "event", TabID: 7, SessionID: "child", Method: "Inspector.detached", Params: json.RawMessage(`{"reason":"target_closed"}`)},
		{Type: "event", TabID: 7, Method: "Inspector.detached", Params: json.RawMessage(`{"reason":"target_closed"}`)},
	} {
		if err = wsjson.Write(ctx, c, event); err != nil {
			t.Fatal(err)
		}
	}
	readCtx, stop := context.WithTimeout(ctx, 3*time.Second)
	defer stop()
	for _, want := range []string{"child", ""} {
		var got struct {
			Method    string `json:"method"`
			SessionID string `json:"sessionId"`
		}
		if err = wsjson.Read(readCtx, client, &got); err != nil || got.Method != "Inspector.detached" || got.SessionID != want {
			t.Fatalf("client received %+v, %v; want Inspector.detached for %q", got, err, want)
		}
	}
	var more json.RawMessage
	if err = wsjson.Read(readCtx, client, &more); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("after the page detached the client read %s, %v; want a normal closure", more, err)
	}
	if detach := next(); detach.Command == nil || detach.Command.Action != "cdp_detach" || detach.Command.Session != attach.Command.Session {
		t.Fatalf("forwarded %+v, want cdp_detach for %s", detach, attach.Command.Session)
	}
}

// A client that stops reading never answers the close frame; the session still
// ends once the close handshake times out after 5 seconds.
func TestPageCDPSessionEndsWhenTheClientIgnoresTheClose(t *testing.T) {
	s, server, c := fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	received := pageClientFixture(ctx, c)
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/devtools/page/7", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Config.Token}}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseNow()
	attach := <-received
	if attach.Command == nil || attach.Command.Action != "cdp_attach" {
		t.Fatalf("forwarded %+v, want cdp_attach", attach)
	}
	detached := time.Now()
	if err = wsjson.Write(ctx, c, Packet{Type: "event", TabID: 7, Method: "Inspector.detached", Params: json.RawMessage(`{"reason":"target_closed"}`)}); err != nil {
		t.Fatal(err)
	}
	select {
	case detach := <-received:
		if detach.Command == nil || detach.Command.Action != "cdp_detach" || detach.Command.Session != attach.Command.Session {
			t.Fatalf("forwarded %+v, want cdp_detach for %s", detach, attach.Command.Session)
		}
		t.Logf("cdp_detach %s after the page detached", time.Since(detached).Round(100*time.Millisecond))
	case <-time.After(8 * time.Second):
		t.Fatal("the session did not end while the client ignored the close frame")
	}
}

func TestArtifactIsAtomicAndNeverOverwrites(t *testing.T) {
	s := New(config.Config{Dir: t.TempDir()})
	cmd := Command{Action: "screenshot", Args: json.RawMessage(`{}`)}
	data := json.RawMessage(`{"data":"aGVsbG8=","mimeType":"image/png"}`)
	out, err := s.saveArtifact(context.Background(), Chrome, cmd, data)
	if err != nil {
		t.Fatal(err)
	}
	var artifact struct {
		Path string `json:"path"`
		Size int    `json:"sizeBytes"`
	}
	if err = json.Unmarshal(out, &artifact); err != nil {
		t.Fatal(err)
	}
	if artifact.Size != 5 {
		t.Fatal(artifact.Size)
	}
	cmd.Args, _ = json.Marshal(map[string]string{"path": artifact.Path})
	if _, err = s.saveArtifact(context.Background(), Chrome, cmd, data); err == nil {
		t.Fatal("existing artifact was overwritten")
	}
}

func BenchmarkHubRoundTrip(b *testing.B) {
	s := New(config.Config{Token: strings.Repeat("a", 64), Dir: b.TempDir()})
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()
	defer s.Hub.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http")+"/extension", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"chrome-extension://" + strings.Repeat("a", 32)}}, Subprotocols: []string{"omw.v1", "omw-token." + s.Config.Token}})
	if err != nil {
		b.Fatal(err)
	}
	defer c.CloseNow()
	_ = wsjson.Write(ctx, c, Packet{Type: "hello", Protocol: Protocol})
	var hello Packet
	_ = wsjson.Read(ctx, c, &hello)
	for !s.Hub.Connected() {
		time.Sleep(time.Millisecond)
	}
	go func() {
		for {
			var msg Packet
			if wsjson.Read(ctx, c, &msg) != nil {
				return
			}
			if msg.Type == "request" {
				_ = wsjson.Write(ctx, c, Packet{Type: "response", ID: msg.ID, Result: json.RawMessage(`{"ok":true}`)})
			}
		}
	}()
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := s.Hub.Call(ctx, Command{Session: "benchmark", Action: "noop"}); err != nil {
				b.Error(err)
			}
		}
	})
}

func TestArtifactDestinationRejectedBeforeBrowserDispatch(t *testing.T) {
	dir := t.TempDir()
	existing := filepath.Join(dir, "keep.txt")
	if err := os.WriteFile(existing, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	s := New(config.Config{Token: strings.Repeat("a", 64), Dir: dir})
	for _, path := range []string{existing, dir, "relative.png"} {
		t.Run(path, func(t *testing.T) {
			args, _ := json.Marshal(map[string]string{"path": path})
			body, _ := json.Marshal(Command{Session: "fixture", Action: "screenshot", Args: args})
			req := httptest.NewRequest("POST", "http://127.0.0.1:17373/command", strings.NewReader(string(body)))
			req.Header.Set("Authorization", "Bearer "+s.Config.Token)
			recorder := httptest.NewRecorder()
			s.Handler().ServeHTTP(recorder, req)
			if recorder.Code != 400 {
				t.Fatalf("destination dispatched to offline browser: %d %s", recorder.Code, recorder.Body.String())
			}
			var reply Reply
			if err := json.Unmarshal(recorder.Body.Bytes(), &reply); err != nil || reply.Error == nil || reply.Error.Code != "invalid_args" {
				t.Fatalf("invalid destination response: %s", recorder.Body.String())
			}
		})
	}
	if data, err := os.ReadFile(existing); err != nil || string(data) != "keep" {
		t.Fatalf("existing file changed: %q %v", data, err)
	}
}

func TestPDFStreamClosesWhenDestinationFails(t *testing.T) {
	s, _, chrome := fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	closed := make(chan error, 1)
	go func() {
		var packet Packet
		if err := wsjson.Read(ctx, chrome, &packet); err != nil {
			closed <- err
			return
		}
		if packet.Command == nil || packet.Command.Action != "artifact_close" || packet.Command.Session != "pdf" || string(packet.Command.Args) != `{"handle":"opaque"}` {
			closed <- fmt.Errorf("unexpected stream cleanup: %+v", packet)
			return
		}
		closed <- wsjson.Write(ctx, chrome, Packet{Type: "response", ID: packet.ID, Result: json.RawMessage(`{}`)})
	}()
	_, err := s.saveArtifact(ctx, Chrome, Command{Action: "save_as_pdf", Session: "pdf", Args: json.RawMessage(`{"path":"relative.pdf"}`)}, json.RawMessage(`{"stream":"opaque"}`))
	if err == nil || fault(err).Code != "invalid_args" {
		t.Fatalf("expected destination error: %v", err)
	}
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
}

func TestPageCDPConcurrentResponsesAndEvents(t *testing.T) {
	s, server, chrome := fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	const count = 32
	done := make(chan error, 1)
	go func() {
		var requests []Packet
		for {
			var packet Packet
			if err := wsjson.Read(ctx, chrome, &packet); err != nil {
				done <- err
				return
			}
			if packet.Command == nil {
				continue
			}
			if packet.Command.Action == "cdp_detach" {
				done <- wsjson.Write(ctx, chrome, Packet{Type: "response", ID: packet.ID, Result: json.RawMessage(`{}`)})
				return
			}
			if packet.Command.Action == "cdp_attach" {
				if err := wsjson.Write(ctx, chrome, Packet{Type: "response", ID: packet.ID, Result: json.RawMessage(`{}`)}); err != nil {
					done <- err
					return
				}
				continue
			}
			requests = append(requests, packet)
			if len(requests) != count {
				continue
			}
			for i := count - 1; i >= 0; i-- {
				var args struct {
					Params struct {
						Value int `json:"value"`
					} `json:"params"`
				}
				if err := json.Unmarshal(requests[i].Command.Args, &args); err != nil {
					done <- err
					return
				}
				result, _ := json.Marshal(map[string]int{"value": args.Params.Value})
				if err := wsjson.Write(ctx, chrome, Packet{Type: "response", ID: requests[i].ID, Result: result}); err != nil {
					done <- err
					return
				}
				if err := wsjson.Write(ctx, chrome, Packet{Type: "event", TabID: 42, Method: "Runtime.consoleAPICalled", Params: json.RawMessage(`{}`)}); err != nil {
					done <- err
					return
				}
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("extension responder did not stop")
		}
	})
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/devtools/page/42", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Config.Token}}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseNow()
	for i := range count {
		if err := wsjson.Write(ctx, client, map[string]any{"id": i + 1, "method": "Runtime.evaluate", "params": map[string]int{"value": i + 1}}); err != nil {
			t.Fatal(err)
		}
	}
	seen := make(map[int]bool)
	events := 0
	for len(seen) < count || events < count {
		var response struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
			Result struct {
				Value int `json:"value"`
			} `json:"result"`
			Error json.RawMessage `json:"error"`
		}
		if err := wsjson.Read(ctx, client, &response); err != nil {
			t.Fatal(err)
		}
		if response.Method == "Runtime.consoleAPICalled" {
			events++
			continue
		}
		if response.ID < 1 || response.ID > count || seen[response.ID] || response.Result.Value != response.ID || len(response.Error) != 0 {
			t.Fatalf("invalid multiplexed response: %+v", response)
		}
		seen[response.ID] = true
	}
}

// The extension may send the page's first events before its cdp_attach reply,
// and a client command, such as one with a large script, may exceed 2 MiB; the
// page CDP connection forwards both.
func TestPageCDPForwardsEarlyEventsAndLargeCommands(t *testing.T) {
	s, server, chrome := fixture(t)
	// Like the browser's WebSocket, the extension stand-in reads large frames.
	chrome.SetReadLimit(MaxMessage)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		for {
			var packet Packet
			if err := wsjson.Read(ctx, chrome, &packet); err != nil {
				done <- err
				return
			}
			if packet.Command == nil {
				continue
			}
			var reply json.RawMessage
			switch packet.Command.Action {
			case "cdp_attach":
				if err := wsjson.Write(ctx, chrome, Packet{Type: "event", TabID: 42, Method: "Page.frameStartedLoading", Params: json.RawMessage(`{"frameId":"main"}`)}); err != nil {
					done <- err
					return
				}
				reply = json.RawMessage(`{"attached":true}`)
			case "cdp":
				var args struct {
					Params struct {
						Expression string `json:"expression"`
					} `json:"params"`
				}
				if err := json.Unmarshal(packet.Command.Args, &args); err != nil {
					done <- err
					return
				}
				reply, _ = json.Marshal(map[string]int{"length": len(args.Params.Expression)})
			default:
				reply = json.RawMessage(`{}`)
			}
			if err := wsjson.Write(ctx, chrome, Packet{Type: "response", ID: packet.ID, Result: reply}); err != nil {
				done <- err
				return
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/devtools/page/42", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Config.Token}}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseNow()
	var got []string
	// evaluate sends a command and reads until its response.
	evaluate := func(id int, expression string) {
		t.Helper()
		if err := wsjson.Write(ctx, client, map[string]any{"id": id, "method": "Runtime.evaluate", "params": map[string]string{"expression": expression}}); err != nil {
			t.Fatalf("command %d after %q: %v", id, got, err)
		}
		readCtx, stop := context.WithTimeout(ctx, 3*time.Second)
		defer stop()
		for {
			var message struct {
				ID     int    `json:"id"`
				Method string `json:"method"`
				Result struct {
					Length int `json:"length"`
				} `json:"result"`
			}
			if err := wsjson.Read(readCtx, client, &message); err != nil {
				t.Fatalf("command %d after %q: %v", id, got, err)
			}
			if message.Method != "" {
				got = append(got, "event "+message.Method)
				continue
			}
			got = append(got, fmt.Sprintf("response %d with %d bytes", message.ID, message.Result.Length))
			if message.ID == id {
				return
			}
		}
	}
	evaluate(1, "1")
	if want := "event Page.frameStartedLoading; response 1 with 1 bytes"; strings.Join(got, "; ") != want {
		t.Fatalf("client received %q, want %s", got, want)
	}
	evaluate(2, strings.Repeat("x", 3<<20))
	if want := fmt.Sprintf("response 2 with %d bytes", 3<<20); got[len(got)-1] != want {
		t.Fatalf("client received %q, want %s", got, want)
	}
}
