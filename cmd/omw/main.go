package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/oh-my-webbridge/oh-my-webbridge/internal/bridge"
	"github.com/oh-my-webbridge/oh-my-webbridge/internal/config"
	"github.com/oh-my-webbridge/oh-my-webbridge/internal/service"
	"github.com/oh-my-webbridge/oh-my-webbridge/skills"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "omw:", err)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 1 && (args[0] == "--version" || args[0] == "version") {
		fmt.Println(bridge.Version)
		return nil
	}
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Println("oh-my-webbridge " + bridge.Version + `

omw serve [--cdp ws://127.0.0.1:9222/devtools/browser/...]  foreground daemon
omw start                       start a background daemon (idempotent)
omw stop                        stop this daemon gracefully; leaves tabs open
omw status | doctor             authenticated diagnostics, one line per browser on stderr
omw pair                        show a one-time code that pairs a browser extension
omw connection                  print the private token for the extension
omw call [--browser chrome|firefox] [--timeout-ms N] SESSION ACTION [JSON|-]
                                run one action (read JSON from stdin with -)
omw service install             install a launchd/systemd user service
omw skill                       print the bundled agent guide
omw install-skill DIRECTORY      install the guide below an explicit skills directory

Use OMW_HOME for a separate configuration directory. The browser endpoint is
fixed at 127.0.0.1:17373; no network-facing bind is supported.`)
		return nil
	}
	c, err := config.Load()
	if err != nil {
		return err
	}
	switch args[0] {
	case "skill":
		fmt.Print(skills.Guide)
		return nil
	case "install-skill":
		if len(args) != 2 {
			return errors.New("usage: omw install-skill DIRECTORY")
		}
		dir := filepath.Join(args[1], "oh-my-webbridge")
		if err = os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		f, err := os.OpenFile(filepath.Join(dir, "SKILL.md"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, err = f.WriteString(skills.Guide)
		closeErr := f.Close()
		if err != nil {
			return err
		}
		return closeErr
	case "serve":
		if len(args) > 1 {
			if len(args) != 3 || args[1] != "--cdp" {
				return errors.New("usage: omw serve [--cdp ws://...]")
			}
			if _, err = bridge.ParseCDP(args[2]); err != nil {
				return err
			}
			c.CDP = args[2]
		}
		return serve(c)
	case "pair":
		return pair(c)
	case "connection":
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"endpoint": "ws://" + c.Address + "/extension", "token": c.Token, "protocol": bridge.Protocol})
	case "status", "doctor":
		if args[0] == "doctor" {
			fmt.Fprintln(os.Stderr, "config:", filepath.Join(c.Dir, "config.json"), "(keep private)")
		}
		return status(c)
	case "stop":
		return request(c, "POST", "/shutdown", nil)
	case "start":
		return start(c)
	case "call":
		cmd, err := callCommand(args[1:], os.Stdin)
		if err != nil {
			return err
		}
		body, err := json.Marshal(cmd)
		if err != nil {
			return err
		}
		return request(c, "POST", "/command", body)
	case "service":
		if len(args) == 2 && args[1] == "install" {
			return service.Install(c.Dir)
		}
		return errors.New("usage: omw service install")
	default:
		return fmt.Errorf("unknown command %q; run omw help", args[0])
	}
}

const callUsage = "usage: omw call [--browser chrome|firefox] [--timeout-ms N] SESSION ACTION [JSON|-]"

// callCommand builds the command that omw call sends. Flags come before the
// session; "--" ends them, for a session name that starts with "-". Without
// --timeout-ms the daemon applies its default deadline.
func callCommand(args []string, stdin io.Reader) (bridge.Command, error) {
	flags := flag.NewFlagSet("call", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	browser := flags.String("browser", "", "")
	timeout := flags.Int("timeout-ms", 0, "")
	if err := flags.Parse(args); err != nil {
		return bridge.Command{}, fmt.Errorf("%w; %s", err, callUsage)
	}
	set := map[string]bool{}
	flags.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if set["browser"] && *browser != bridge.Chrome && *browser != bridge.Firefox {
		return bridge.Command{}, errors.New("--browser must be chrome or firefox")
	}
	if set["timeout-ms"] && (*timeout < 1 || *timeout > 120000) {
		return bridge.Command{}, errors.New("--timeout-ms must be 1 to 120000")
	}
	rest := flags.Args()
	if len(rest) < 2 || len(rest) > 3 {
		return bridge.Command{}, errors.New(callUsage)
	}
	raw := []byte(`{}`)
	if len(rest) == 3 {
		if rest[2] == "-" {
			var err error
			if raw, err = io.ReadAll(io.LimitReader(stdin, 2<<20)); err != nil {
				return bridge.Command{}, err
			}
		} else {
			raw = []byte(rest[2])
		}
	}
	if !json.Valid(raw) || len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
		return bridge.Command{}, errors.New("args must be a JSON object")
	}
	return bridge.Command{Session: rest[0], Action: rest[1], Browser: *browser, Args: raw, TimeoutMS: *timeout}, nil
}

func clientRequest(c config.Config, method, path string, body []byte) (*http.Response, error) {
	req, err := http.NewRequest(method, "http://"+c.Address+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	timeout := 5 * time.Second
	if path == "/command" {
		timeout = 125 * time.Second
	}
	return (&http.Client{Timeout: timeout, Transport: &http.Transport{Proxy: nil}}).Do(req)
}
func request(c config.Config, method, path string, body []byte) error {
	res, err := clientRequest(c, method, path, body)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, err = io.Copy(os.Stdout, res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return nil
}

// decode reads one JSON reply of an authenticated request.
func decode(res *http.Response, out any) error {
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.Unmarshal(body, out)
}

// pair shows a one-time code for the extension and waits until the extension
// uses it or the code stops working.
func pair(c config.Config) error {
	res, err := clientRequest(c, "POST", "/pairing", nil)
	if err != nil {
		return fmt.Errorf("the daemon is not running; start it with omw start: %w", err)
	}
	var started struct {
		Code    string `json:"code"`
		Expires int    `json:"expires_in_seconds"`
	}
	if err = decode(res, &started); err != nil {
		return fmt.Errorf("start pairing: %w", err)
	}
	if len(started.Code) != 6 {
		return fmt.Errorf("start pairing: unexpected code %q", started.Code)
	}
	fmt.Printf("Enter this code in the oh-my-webbridge extension:\n\n    %s %s\n\nIt works once and expires in %d minutes.\n", started.Code[:3], started.Code[3:], started.Expires/60)
	expired := errors.New("the code is no longer valid; run omw pair again")
	deadline := time.Now().Add(time.Duration(started.Expires)*time.Second + time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		res, err = clientRequest(c, "GET", "/pairing", nil)
		if err != nil {
			return fmt.Errorf("check pairing: %w", err)
		}
		var state bridge.PairingState
		if err = decode(res, &state); err != nil {
			return fmt.Errorf("check pairing: %w", err)
		}
		switch state.State {
		case "paired":
			name := map[string]string{bridge.Chrome: "Chrome", bridge.Firefox: "Firefox"}[state.Browser]
			fmt.Printf("Paired with %s.\n", name)
			return nil
		case "expired":
			return expired
		}
	}
	return expired
}

// status prints the daemon's /status JSON and one line per browser on stderr.
func status(c config.Config) error {
	res, err := clientRequest(c, "GET", "/status", nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if _, err = os.Stdout.Write(body); err != nil {
		return err
	}
	if res.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var report struct {
		Browsers []bridge.BrowserStatus `json:"browsers"`
	}
	if err = json.Unmarshal(body, &report); err != nil {
		return fmt.Errorf("read status: %w", err)
	}
	for _, browser := range []string{bridge.Chrome, bridge.Firefox} {
		line := browser + ": not connected"
		for _, b := range report.Browsers {
			if b.Browser == browser && b.Connected {
				line = browser + ": connected"
				if b.BrowserVersion != "" {
					line += " (" + b.BrowserVersion + ")"
				}
			}
		}
		fmt.Fprintln(os.Stderr, line)
	}
	return nil
}
func serve(c config.Config) error {
	if c.Address != config.Address {
		return fmt.Errorf("address must be %s", config.Address)
	}
	listener, err := net.Listen("tcp", c.Address)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	api := bridge.New(c)
	api.Shutdown = stop
	server := &http.Server{Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 125 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		api.Hub.Close()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			slog.Error("shutdown", "error", err)
		}
	}()
	slog.Info("bridge ready", "address", c.Address, "protocol", bridge.Protocol)
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		<-shutdownDone
		return nil
	}
	return err
}
func start(c config.Config) error {
	res, err := clientRequest(c, "GET", "/status", nil)
	if err == nil {
		res.Body.Close()
		if res.StatusCode == 200 {
			fmt.Println("already running")
			return nil
		}
		return fmt.Errorf("port occupied or credential mismatch (HTTP %d)", res.StatusCode)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// Keep one bounded startup log; normal operation emits no per-request logs.
	log, err := os.OpenFile(filepath.Join(c.Dir, "daemon.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.Command(exe, "serve")
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Env = append(os.Environ(), "OMW_HOME="+c.Dir)
	if err = cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	for range 40 {
		time.Sleep(50 * time.Millisecond)
		res, err = clientRequest(c, "GET", "/status", nil)
		if err == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				fmt.Println("started")
				return nil
			}
			if res.StatusCode == 401 {
				return errors.New("daemon credential mismatch")
			}
		}
	}
	b, _ := os.ReadFile(filepath.Join(c.Dir, "daemon.log"))
	return fmt.Errorf("daemon did not become ready: %s", strings.TrimSpace(string(b)))
}
