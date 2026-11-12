package main

import (
	"strings"
	"testing"
	"time"

	"github.com/oh-my-webbridge/oh-my-webbridge/internal/config"
)

func TestCallCommandFlags(t *testing.T) {
	cmd, err := callCommand([]string{"--timeout-ms", "5000", "repro", "wait", `{"url":"*nomatch*"}`}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Session != "repro" || cmd.Action != "wait" || cmd.TimeoutMS != 5000 || cmd.Browser != "" || string(cmd.Args) != `{"url":"*nomatch*"}` {
		t.Fatalf("timeout flag: %+v", cmd)
	}
	cmd, err = callCommand([]string{"--browser", "firefox", "--timeout-ms=200", "repro", "snapshot"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Browser != "firefox" || cmd.TimeoutMS != 200 || string(cmd.Args) != "{}" {
		t.Fatalf("both flags: %+v", cmd)
	}
	cmd, err = callCommand([]string{"repro", "snapshot"}, nil)
	if err != nil || cmd.TimeoutMS != 0 {
		t.Fatalf("default deadline: %+v %v", cmd, err)
	}
	cmd, err = callCommand([]string{"--", "-task", "click", "-"}, strings.NewReader(`{"selector":"#go"}`))
	if err != nil || cmd.Session != "-task" || string(cmd.Args) != `{"selector":"#go"}` {
		t.Fatalf("session after --: %+v %v", cmd, err)
	}
}

func TestCallCommandRejectsBadArguments(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--timeout-ms", "0", "repro", "wait"}, "--timeout-ms must be 1 to 120000"},
		{[]string{"--timeout-ms", "120001", "repro", "wait"}, "--timeout-ms must be 1 to 120000"},
		{[]string{"--timeout-ms", "soon", "repro", "wait"}, "usage: omw call"},
		{[]string{"--browser", "safari", "repro", "wait"}, "--browser must be chrome or firefox"},
		{[]string{"--browser", "", "repro", "wait"}, "--browser must be chrome or firefox"},
		{[]string{"--retries", "2", "repro", "wait"}, "usage: omw call"},
		{[]string{"repro"}, "usage: omw call"},
		{[]string{"repro", "wait", "[1]"}, "args must be a JSON object"},
	} {
		if _, err := callCommand(tc.args, nil); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%q: got %v, want %q", tc.args, err, tc.want)
		}
	}
}

// A native CDP endpoint from config.json is checked as --cdp is, before the
// daemon listens.
func TestServeRejectsAnInvalidCDPEndpoint(t *testing.T) {
	done := make(chan error, 1)
	go func() {
		done <- serve(config.Config{Address: config.Address, CDP: "http://127.0.0.1:9222/devtools/browser/x"})
	}()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "requires an explicit ws:// or wss:// browser endpoint") {
			t.Fatalf("serve with an http:// cdp endpoint: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve started with an invalid cdp endpoint")
	}
}
