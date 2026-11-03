package bridge

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/oh-my-webbridge/oh-my-webbridge/internal/config"
)

// newServerIn starts a daemon on the configuration directory dir, as a
// restarted daemon does with the same OMW_HOME.
func newServerIn(t *testing.T, dir string) (*Server, *httptest.Server) {
	t.Helper()
	s := New(config.Config{Token: strings.Repeat("a", 64), Dir: dir})
	server := httptest.NewServer(s.Handler())
	t.Cleanup(server.Close)
	t.Cleanup(s.Hub.Close)
	return s, server
}

// stop ends a daemon: its extension connections first, then the listener.
func stop(s *Server, server *httptest.Server) {
	s.Hub.Close()
	server.Close()
}

// A restarted daemon keeps the bindings of the previous one. When Chrome
// reconnects first, a Firefox session gets browser_offline instead of being
// bound to Chrome, and it reaches Firefox once Firefox reconnects.
func TestBindingsSurviveDaemonRestart(t *testing.T) {
	dir := t.TempDir()
	first, firstServer := newServerIn(t, dir)
	connect(t, first, firstServer, chromeExtension, Packet{Browser: Chrome, Sessions: []string{}})
	connect(t, first, firstServer, firefoxExtension, Packet{Browser: Firefox, Sessions: []string{}})
	if got := routed(t, first, firstServer, "fx", Firefox); got != Firefox {
		t.Fatalf("fx ran in %s", got)
	}
	if got := routed(t, first, firstServer, "cr", ""); got != Chrome {
		t.Fatalf("cr ran in %s", got)
	}
	stop(first, firstServer)

	second, secondServer := newServerIn(t, dir)
	connect(t, second, secondServer, chromeExtension, Packet{Browser: Chrome, Sessions: []string{"cr"}})
	reply := fails(t, second, secondServer, map[string]any{"session": "fx", "action": "echo"}, 503, "browser_offline")
	if !strings.Contains(reply.Error.Message, Firefox) {
		t.Fatalf("browser_offline does not name Firefox: %q", reply.Error.Message)
	}
	fails(t, second, secondServer, map[string]any{"session": "fx", "action": "echo", "browser": Chrome}, 409, "session_browser")
	if got := routed(t, second, secondServer, "cr", ""); got != Chrome {
		t.Fatalf("cr ran in %s after the restart", got)
	}
	connect(t, second, secondServer, firefoxExtension, Packet{Browser: Firefox, Sessions: []string{"fx"}})
	if got := routed(t, second, secondServer, "fx", ""); got != Firefox {
		t.Fatalf("fx ran in %s after Firefox reconnected", got)
	}
	// close_session removes the saved binding as well.
	if code, reply := post(t, second, secondServer, map[string]any{"session": "fx", "action": "close_session"}); code != 200 {
		t.Fatalf("close_session: %d %+v", code, reply.Error)
	}
	stop(second, secondServer)

	third, thirdServer := newServerIn(t, dir)
	connect(t, third, thirdServer, chromeExtension, Packet{Browser: Chrome, Sessions: []string{"cr"}})
	if got := routed(t, third, thirdServer, "fx", ""); got != Chrome {
		t.Fatalf("closed session fx kept its saved binding: ran in %s", got)
	}
}
