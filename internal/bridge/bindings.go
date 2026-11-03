package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
)

// BindingsFile is the record of the session bindings in the configuration
// directory. A restarted daemon loads it, so a bound session keeps going to its
// browser, or gets browser_offline, until that browser's extension reconnects
// and its hello updates the bindings.
const BindingsFile = "bindings.json"

const bindingsVersion = 1

// The record holds at most MaxSessions names of up to 96 characters per browser.
const maxBindingsFile = 1 << 20

type bindingRecord struct {
	Version  int               `json:"version"`
	Bindings map[string]string `json:"bindings"`
}

// readBindings returns the bindings saved in path; a missing file holds none.
func readBindings(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxBindingsFile+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxBindingsFile {
		return nil, fmt.Errorf("larger than %d bytes", maxBindingsFile)
	}
	var record bindingRecord
	if err = json.Unmarshal(data, &record); err != nil {
		return nil, err
	}
	if record.Version != bindingsVersion {
		return nil, fmt.Errorf("version %d, expected %d", record.Version, bindingsVersion)
	}
	counts := map[string]int{}
	for session, browser := range record.Bindings {
		if !sessionPattern.MatchString(session) {
			return nil, fmt.Errorf("invalid session name %q", session)
		}
		if browser != Chrome && browser != Firefox {
			return nil, fmt.Errorf("session %s is bound to unknown browser %q", session, browser)
		}
		if counts[browser]++; counts[browser] > MaxSessions {
			return nil, fmt.Errorf("more than %d sessions are bound to %s", MaxSessions, browser)
		}
	}
	if record.Bindings == nil {
		return map[string]string{}, nil
	}
	return record.Bindings, nil
}

// writeBindings replaces the record at path: a private temporary file in the
// same directory is renamed over it, so a reader sees the old or the new record.
// It is not synced; a record that a power failure loses or tears is ignored at
// the next start, and the extensions' hellos rebuild the bindings.
func writeBindings(path string, bindings map[string]string) error {
	data, err := json.Marshal(bindingRecord{Version: bindingsVersion, Bindings: bindings})
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".bindings-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// keepBindings loads the bindings saved at path and saves their changes there.
// An unusable record is logged and ignored, and the next change replaces it:
// the record only covers the time until the extensions' hellos rebuild the
// bindings, and refusing to start the daemon over it would stop every session.
func (h *Hub) keepBindings(path string) {
	bindings, err := readBindings(path)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.store = path
	if err != nil {
		slog.Warn("ignoring the saved session bindings; the extensions' hellos rebuild them", "path", path, "error", err)
		return
	}
	h.bindings = bindings
}

// save writes the bindings if they changed since the last write. Writes run one
// at a time outside h.mu, each with the newest bindings. A failed write is
// logged and left until the next change; routing keeps the bindings in memory.
func (h *Hub) save() {
	h.mu.Lock()
	changed := h.store != "" && h.revision != h.saved
	h.mu.Unlock()
	if !changed {
		return
	}
	h.saving.Lock()
	defer h.saving.Unlock()
	h.mu.Lock()
	path, revision, bindings := h.store, h.revision, maps.Clone(h.bindings)
	written := revision == h.saved
	h.mu.Unlock()
	if written {
		return
	}
	if err := writeBindings(path, bindings); err != nil {
		slog.Warn("save session bindings", "path", path, "error", err)
	}
	h.mu.Lock()
	h.saved = revision
	h.mu.Unlock()
}
