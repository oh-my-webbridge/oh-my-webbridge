package skills

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
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
