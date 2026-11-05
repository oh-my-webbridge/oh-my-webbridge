package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const Address = "127.0.0.1:17373"

type Config struct {
	Dir     string `json:"-"`
	Token   string `json:"token"`
	Address string `json:"address"`
	CDP     string `json:"cdp,omitempty"`
}

func Load() (Config, error) {
	dir := os.Getenv("OMW_HOME")
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return Config{}, err
		}
		dir = filepath.Join(base, "oh-my-webbridge")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return Config{}, err
	}
	c := Config{Dir: dir, Address: Address}
	b, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err == nil {
		if err := json.Unmarshal(b, &c); err != nil {
			return c, fmt.Errorf("read config: %w", err)
		}
		if len(c.Token) != 64 {
			return c, errors.New("config token must be 32 random bytes encoded as hex")
		}
		return c, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return c, err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return c, err
	}
	c.Token = hex.EncodeToString(secret)
	b, err = json.MarshalIndent(c, "", "  ")
	if err != nil {
		return c, err
	}
	// Publish a fully written inode atomically. Other first-start processes must
	// never observe the empty file between O_EXCL and Write.
	f, err := os.CreateTemp(dir, ".config-*")
	if err != nil {
		return c, err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		f.Close()
		return c, err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return c, err
	}
	if err = f.Close(); err != nil {
		return c, err
	}
	err = os.Link(f.Name(), filepath.Join(dir, "config.json"))
	if errors.Is(err, os.ErrExist) {
		return Load()
	}
	return c, err
}
