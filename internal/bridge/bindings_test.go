package bridge

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// captureLogs collects the default logger's output for the rest of the test.
func captureLogs(t *testing.T) *lockedBuffer {
	t.Helper()
	logs := &lockedBuffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return logs
}

func savedBindings(t *testing.T, dir string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, BindingsFile))
	if err != nil {
		t.Fatal(err)
	}
	var record struct {
		Version  int               `json:"version"`
		Bindings map[string]string `json:"bindings"`
	}
	if err = json.Unmarshal(data, &record); err != nil || record.Version != 1 {
		t.Fatalf("bindings record %s: %v", data, err)
	}
	return record.Bindings
}

// The record is a private file that is replaced whole; no temporary file stays.
func TestBindingsRecordIsPrivate(t *testing.T) {
	dir := t.TempDir()
	s, server := newServerIn(t, dir)
	connect(t, s, server, firefoxExtension, Packet{Browser: Firefox, Sessions: []string{}})
	routed(t, s, server, "fx", "")
	routed(t, s, server, "fx2", "")
	info, err := os.Stat(filepath.Join(dir, BindingsFile))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("bindings record mode %v", info.Mode().Perm())
	}
	if got := savedBindings(t, dir); len(got) != 2 || got["fx"] != Firefox || got["fx2"] != Firefox {
		t.Fatalf("saved bindings %v", got)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".bindings-") {
			t.Fatalf("temporary record %s left behind", entry.Name())
		}
	}
}

// A hello merges with the saved bindings under the rules for a live daemon:
// it drops its browser's sessions that the extension no longer holds and does
// not take over a session bound to the other browser.
func TestHelloMergesWithSavedBindings(t *testing.T) {
	logs := captureLogs(t)
	dir := t.TempDir()
	first, firstServer := newServerIn(t, dir)
	connect(t, first, firstServer, firefoxExtension, Packet{Browser: Firefox, Sessions: []string{}})
	routed(t, first, firstServer, "fx", "")
	routed(t, first, firstServer, "stale", "")
	stop(first, firstServer)

	second, secondServer := newServerIn(t, dir)
	connect(t, second, secondServer, chromeExtension, Packet{Browser: Chrome, Sessions: []string{"fx", "cr"}})
	connect(t, second, secondServer, firefoxExtension, Packet{Browser: Firefox, Sessions: []string{"fx"}})
	if got := savedBindings(t, dir); len(got) != 2 || got["fx"] != Firefox || got["cr"] != Chrome {
		t.Fatalf("saved bindings after the hellos: %v", got)
	}
	if got := routed(t, second, secondServer, "fx", ""); got != Firefox {
		t.Fatalf("Chrome's hello took over the saved fx binding: %s", got)
	}
	if got := routed(t, second, secondServer, "stale", ""); got != Chrome {
		t.Fatalf("stale binding survived Firefox's hello: %s", got)
	}
	if !strings.Contains(logs.String(), "already bound to another browser") {
		t.Fatalf("no conflict warning: %q", logs.String())
	}
}

// An unusable record is logged and ignored; the daemon starts without saved
// bindings and replaces the record at the next change.
func TestUnusableBindingsRecordIsIgnored(t *testing.T) {
	many := map[string]string{}
	for i := range MaxSessions + 1 {
		many[fmt.Sprintf("s%d", i)] = Chrome
	}
	tooMany, _ := json.Marshal(map[string]any{"version": 1, "bindings": many})
	for name, content := range map[string]string{
		"malformed":       "{",
		"other version":   `{"version":2,"bindings":{"fx":"firefox"}}`,
		"unknown browser": `{"version":1,"bindings":{"fx":"safari"}}`,
		"invalid session": `{"version":1,"bindings":{"a b":"firefox"}}`,
		"over the limit":  string(tooMany),
		"too large":       `{"version":1,"bindings":{}}` + strings.Repeat(" ", maxBindingsFile),
	} {
		t.Run(name, func(t *testing.T) {
			logs := captureLogs(t)
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, BindingsFile), []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			s, server := newServerIn(t, dir)
			if !strings.Contains(logs.String(), "ignoring the saved session bindings") || !strings.Contains(logs.String(), dir) {
				t.Fatalf("no warning for the unusable record: %q", logs.String())
			}
			connect(t, s, server, chromeExtension, Packet{Browser: Chrome, Sessions: []string{}})
			if got := routed(t, s, server, "fx", ""); got != Chrome {
				t.Fatalf("an unusable record still bound fx: %s", got)
			}
			if got := savedBindings(t, dir); len(got) != 1 || got["fx"] != Chrome {
				t.Fatalf("record after the next binding: %v", got)
			}
		})
	}
}

// A record that cannot be written is logged; routing keeps the binding.
func TestBindingsWriteFailureKeepsRouting(t *testing.T) {
	logs := captureLogs(t)
	dir := t.TempDir()
	s, server := newServerIn(t, dir)
	connect(t, s, server, firefoxExtension, Packet{Browser: Firefox, Sessions: []string{}})
	if err := os.Chmod(dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0700) })
	if got := routed(t, s, server, "fx", ""); got != Firefox {
		t.Fatalf("fx ran in %s", got)
	}
	connect(t, s, server, chromeExtension, Packet{Browser: Chrome, Sessions: []string{}})
	if got := routed(t, s, server, "fx", ""); got != Firefox {
		t.Fatalf("binding lost after a failed write: %s", got)
	}
	if !strings.Contains(logs.String(), "save session bindings") {
		t.Fatalf("no warning for the failed write: %q", logs.String())
	}
}
