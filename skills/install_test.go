package skills

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	docs "github.com/oh-my-webbridge/oh-my-webbridge/docs/content/docs"
)

func TestInstallAndRefresh(t *testing.T) {
	parent := t.TempDir()
	if err := Install(parent, false); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(parent, "oh-my-webbridge")
	if err := Install(parent, false); err == nil {
		t.Fatal("second installation replaced an existing guide")
	}
	for _, name := range []string{"SKILL.md", "notes.md", "references/reference/actions.mdx"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("user data"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := Install(parent, true); err != nil {
		t.Fatal(err)
	}
	check := func(path string, want []byte) {
		t.Helper()
		got, err := os.ReadFile(filepath.Join(dir, path))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s: content mismatch or read error: %v", path, err)
		}
	}
	check("notes.md", []byte("user data"))
	check("SKILL.md", []byte(Guide))
	err := fs.WalkDir(docs.References, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := docs.References.ReadFile(path)
		if err == nil {
			check(filepath.Join("references", path), data)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRefreshChecksPathConflictsBeforeReplacingFiles(t *testing.T) {
	const oldContent = "existing content"
	for _, tc := range []struct {
		name string
		path string
		kind string
	}{
		{name: "file in references directory path", path: "references", kind: "file"},
		{name: "symlink in references directory path", path: "references", kind: "symlink"},
		{name: "directory in reference file path", path: "references/reference/sdk.mdx", kind: "directory"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parent := t.TempDir()
			target := filepath.Join(parent, "oh-my-webbridge")
			conflict := filepath.Join(target, tc.path)
			if err := os.MkdirAll(filepath.Dir(conflict), 0700); err != nil {
				t.Fatal(err)
			}
			preserved := []string{filepath.Join(target, "SKILL.md"), filepath.Join(target, "notes.md")}
			switch tc.kind {
			case "file":
				preserved = append(preserved, conflict)
			case "symlink":
				outside := t.TempDir()
				if err := os.Symlink(outside, conflict); err != nil {
					if runtime.GOOS == "windows" {
						t.Skipf("creating directory symlink: %v", err)
					}
					t.Fatal(err)
				}
				preserved = append(preserved, filepath.Join(outside, "firefox.mdx"))
			case "directory":
				if err := os.Mkdir(conflict, 0700); err != nil {
					t.Fatal(err)
				}
				preserved = append(preserved, filepath.Join(target, "references", "firefox.mdx"), filepath.Join(conflict, "notes.md"))
			}
			for _, path := range preserved {
				if err := os.WriteFile(path, []byte(oldContent), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := Install(parent, true); err == nil || !strings.Contains(err.Error(), conflict) {
				t.Fatalf("expected refresh error for %s, got %v", conflict, err)
			}
			for _, path := range preserved {
				got, err := os.ReadFile(path)
				if err != nil || string(got) != oldContent {
					t.Errorf("%s: got %q, %v, want %q", path, got, err, oldContent)
				}
			}
		})
	}
}
