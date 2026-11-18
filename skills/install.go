package skills

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

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
	// Serialize refreshes across CLI processes without adding a file to the
	// installed Skill. Closing the directory also releases its advisory lock.
	lock, err := os.Open(parent)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	if err := os.Rename(stage, target); err == nil {
		return nil
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
	return replaceFiles(stage, target, files)
}

func replaceFiles(stage, target string, files []string) error {
	backup, err := os.MkdirTemp(filepath.Dir(stage), ".omw-previous-")
	if err != nil {
		return err
	}
	type change struct{ dst, saved string }
	var changes []change
	for i, rel := range files {
		dst := filepath.Join(target, rel)
		saved := filepath.Join(backup, fmt.Sprint(i))
		// Keep the live path readable until replacement where hard links
		// are supported. Otherwise move the original aside for rollback.
		err = os.Link(dst, saved)
		moved := false
		if err != nil && !os.IsNotExist(err) {
			err = os.Rename(dst, saved)
			moved = err == nil
		}
		if os.IsNotExist(err) {
			saved = ""
		} else if err != nil {
			break
		}
		if moved {
			changes = append(changes, change{dst, saved})
		}
		if err = os.Rename(filepath.Join(stage, rel), dst); err != nil {
			break
		}
		if !moved {
			changes = append(changes, change{dst, saved})
		}
	}
	var recovery error
	if err != nil {
		for i := len(changes) - 1; i >= 0; i-- {
			c := changes[i]
			if c.saved == "" {
				recovery = errors.Join(recovery, os.Remove(c.dst))
			} else {
				recovery = errors.Join(recovery, os.Rename(c.saved, c.dst))
			}
		}
	}
	if recovery != nil {
		return errors.Join(err, fmt.Errorf("restore from %s: %w", backup, recovery))
	}
	return errors.Join(err, os.RemoveAll(backup))
}
