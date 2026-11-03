package config

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestConcurrentFirstLoad(t *testing.T) {
	t.Setenv("OMW_HOME", t.TempDir())
	var wg sync.WaitGroup
	tokens := make(chan string, 32)
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := Load()
			if err != nil {
				t.Error(err)
				return
			}
			tokens <- c.Token
		}()
	}
	wg.Wait()
	close(tokens)
	var expected string
	for token := range tokens {
		if expected == "" {
			expected = token
		}
		if token != expected {
			t.Error("concurrent initialization rotated token")
		}
	}
	f, err := os.Stat(filepath.Join(os.Getenv("OMW_HOME"), "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if f.Mode().Perm() != 0600 {
		t.Fatalf("token permissions: %o", f.Mode().Perm())
	}
}
