package skills

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	docs "github.com/oh-my-webbridge/oh-my-webbridge/docs/content/docs"
)

// Install writes a complete guide off to the side before publishing it.
// Refresh replaces only paths shipped by this build.
func Install(parent string, refresh bool) error {
	if err := os.MkdirAll(parent, 0700); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(parent, ".omw-skill-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := os.WriteFile(filepath.Join(stage, "SKILL.md"), []byte(Guide), 0600); err != nil {
		return err
	}
	if err := os.CopyFS(filepath.Join(stage, "references"), docs.References); err != nil {
		return err
	}
	target := filepath.Join(parent, "oh-my-webbridge")
	if !refresh {
		return os.Rename(stage, target)
	}
	var dirs, files []string
	if err := filepath.WalkDir(stage, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(stage, path)
		if err != nil {
			return err
		}
		dst := filepath.Join(target, rel)
		info, err := os.Lstat(dst)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if entry.IsDir() {
			if info != nil && !info.IsDir() {
				return fmt.Errorf("expected a directory at %s", dst)
			}
			dirs = append(dirs, dst)
		} else {
			if info != nil && !info.Mode().IsRegular() {
				return fmt.Errorf("expected a regular file at %s", dst)
			}
			files = append(files, rel)
		}
		return nil
	}); err != nil {
		return err
	}
	for _, dir := range dirs {
		if err := os.Mkdir(dir, 0700); err != nil {
			if !os.IsExist(err) {
				return err
			}
			info, err := os.Lstat(dir)
			if err != nil {
				return err
			}
			if !info.IsDir() {
				return fmt.Errorf("expected a directory at %s", dir)
			}
		}
	}
	for _, rel := range files {
		if err := os.Rename(filepath.Join(stage, rel), filepath.Join(target, rel)); err != nil {
			return err
		}
	}
	return nil
}
