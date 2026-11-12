package bridge

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/oh-my-webbridge/oh-my-webbridge/internal/config"
)

type Server struct {
	Config    config.Config
	Hub       *Hub
	Started   time.Time
	Shutdown  func()
	admitted  chan struct{}
	ordinary  map[string]chan struct{}
	artifacts chan struct{}
	uploads   uploadBudget
	pairing   pairing
}

func New(c config.Config) *Server {
	s := &Server{
		Config:  c,
		Hub:     NewHub(),
		Started: time.Now(),
		// Requests decoded or running at once: the ordinary slots and the
		// recovery reserve of both browsers.
		admitted:  make(chan struct{}, 2*(maxPending+recoveryReserve)),
		ordinary:  map[string]chan struct{}{Chrome: make(chan struct{}, maxPending), Firefox: make(chan struct{}, maxPending)},
		artifacts: make(chan struct{}, 2),
		pairing:   pairing{now: time.Now},
	}
	if c.Dir != "" {
		s.Hub.keepBindings(filepath.Join(c.Dir, BindingsFile))
	}
	return s
}

var sessionPattern = regexp.MustCompile(`^[\pL\pN_.-]{1,96}$`)
var chromeOrigin = regexp.MustCompile(`^chrome-extension://[a-p]{32}$`)

// Firefox assigns each installation a random UUID host.
var firefoxOrigin = regexp.MustCompile(`^moz-extension://[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// originBrowser names the browser of an extension Origin, or "" for any other origin.
func originBrowser(origin string) string {
	switch {
	case chromeOrigin.MatchString(origin):
		return Chrome
	case firefoxOrigin.MatchString(origin):
		return Firefox
	}
	return ""
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", s.status)
	mux.HandleFunc("GET /ping", s.ping)
	mux.HandleFunc("POST /pair", s.pair)
	mux.HandleFunc("POST /pairing", s.startPairing)
	mux.HandleFunc("GET /pairing", s.pairingState)
	mux.HandleFunc("POST /command", s.command)
	mux.HandleFunc("GET /extension", s.extension)
	mux.HandleFunc("GET /json/list", s.targets)
	mux.HandleFunc("GET /json/list/{$}", s.targets)
	mux.HandleFunc("GET /json", s.targets)
	mux.HandleFunc("GET /json/version", s.version)
	mux.HandleFunc("GET /json/version/{$}", s.version)
	mux.HandleFunc("GET /devtools/page/{tab}", s.pageCDP)
	mux.HandleFunc("GET /devtools/browser", s.browserCDP)
	mux.HandleFunc("POST /shutdown", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, 200, map[string]bool{"stopping": true})
		if s.Shutdown != nil {
			go s.Shutdown()
		}
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil || host != "127.0.0.1" {
			http.Error(w, "loopback Host required", 403)
			return
		}
		origin := r.Header.Get("Origin")
		// Extension pages reach /extension with a token, and /ping and /pair
		// before they have one. Every other caller sends no Origin.
		extensionPath := r.URL.Path == "/extension" || r.URL.Path == "/ping" || r.URL.Path == "/pair"
		if origin != "" && !(extensionPath && originBrowser(origin) != "") {
			http.Error(w, "web origins are not allowed", 403)
			return
		}
		// Browsers omit Origin on an extension page's GET, so /ping answers
		// without one; it reports only the version. Redeeming a code is a POST,
		// which always carries the extension Origin.
		if r.URL.Path == "/ping" {
			mux.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/pair" {
			if originBrowser(origin) == "" {
				http.Error(w, "extension origin required", 403)
				return
			}
			mux.ServeHTTP(w, r)
			return
		}
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if r.URL.Path == "/extension" {
			for _, protocol := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
				protocol = strings.TrimSpace(protocol)
				if strings.HasPrefix(protocol, "omw-token.") {
					token = strings.TrimPrefix(protocol, "omw-token.")
				}
			}
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(s.Config.Token)) != 1 {
			http.Error(w, "authentication required", 401)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func jsonOut(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	var usage syscall.Rusage
	peakRSS := int64(0)
	if syscall.Getrusage(syscall.RUSAGE_SELF, &usage) == nil {
		peakRSS = usage.Maxrss
		if runtime.GOOS == "linux" {
			peakRSS *= 1024
		}
	}
	jsonOut(w, 200, map[string]any{"running": true, "version": Version, "protocol": Protocol, "extension_connected": s.Hub.Connected(), "browsers": s.Hub.Browsers(), "inflight": s.Hub.Inflight(), "uptime_seconds": int(time.Since(s.Started).Seconds()), "native_cdp": s.Config.CDP != "", "memory": map[string]any{"heap_alloc_bytes": mem.HeapAlloc, "heap_sys_bytes": mem.HeapSys, "peak_rss_bytes": peakRSS, "goroutines": runtime.NumGoroutine()}})
}
func (s *Server) command(w http.ResponseWriter, r *http.Request) {
	// Every command holds an admitted slot while its body is read and it runs.
	// Once its browser is resolved, an ordinary command also needs one of that
	// browser's ordinary slots, so close_session and dialog keep the recovery
	// reserve and commands waiting in one browser leave the other's slots free.
	select {
	case s.admitted <- struct{}{}:
		defer func() { <-s.admitted }()
	default:
		jsonOut(w, 429, Reply{Error: &Fault{"busy", "command capacity reached"}})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	var cmd Command
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(&cmd); err != nil {
		jsonOut(w, 400, Reply{Error: &Fault{"invalid_request", err.Error()}})
		return
	}
	if err := d.Decode(new(any)); err != io.EOF {
		jsonOut(w, 400, Reply{Error: &Fault{"invalid_request", "expected one JSON object"}})
		return
	}
	if !sessionPattern.MatchString(cmd.Session) || cmd.Action == "" {
		jsonOut(w, 400, Reply{Error: &Fault{"invalid_request", "action and session (1–96 letters, digits, _, ., -) required"}})
		return
	}
	if cmd.Browser != "" && cmd.Browser != Chrome && cmd.Browser != Firefox {
		jsonOut(w, 400, Reply{Error: &Fault{"invalid_request", "browser must be chrome or firefox"}})
		return
	}
	if cmd.TimeoutMS == 0 {
		cmd.TimeoutMS = 30000
	}
	if cmd.TimeoutMS < 1 || cmd.TimeoutMS > 120000 {
		jsonOut(w, 400, Reply{Error: &Fault{"invalid_request", "timeoutMs must be 1–120000"}})
		return
	}
	if cmd.ID == "" {
		cmd.ID = NewID()
	}
	if len(cmd.Args) == 0 {
		cmd.Args = json.RawMessage(`{}`)
	}
	artifact := cmd.Action == "screenshot" || cmd.Action == "save_as_pdf"
	if artifact {
		if _, err := artifactPath(cmd.Args); err != nil {
			jsonOut(w, 400, Reply{ID: cmd.ID, Error: fault(err)})
			return
		}
	}
	// The command takes the slot of the browser it resolves to, and Firefox
	// upload contents are inlined for it. CallResolved sends it only to that
	// browser, so a route change before dispatch neither uses the other
	// browser's slot nor delivers Firefox upload contents to Chrome.
	target, err := s.Hub.Resolve(cmd.Session, cmd.Browser)
	if err != nil {
		replyError(w, cmd.ID, err)
		return
	}
	if !recovery(cmd.Action) {
		select {
		case s.ordinary[target] <- struct{}{}:
			defer func() { <-s.ordinary[target] }()
		default:
			jsonOut(w, 429, Reply{ID: cmd.ID, Error: &Fault{"busy", "command capacity reached for " + target}})
			return
		}
	}
	// The Firefox extension cannot read local files; send their bytes instead.
	if target == Firefox && (cmd.Action == "upload" || cmd.Action == "batch") {
		held, err := inlineUploads(&cmd, &s.uploads)
		defer s.uploads.release(held)
		if err != nil {
			replyError(w, cmd.ID, err)
			return
		}
	}
	if artifact {
		select {
		case s.artifacts <- struct{}{}:
			defer func() { <-s.artifacts }()
		default:
			jsonOut(w, 429, Reply{ID: cmd.ID, Error: &Fault{"busy", "two artifact jobs are already running"}})
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(cmd.TimeoutMS)*time.Millisecond)
	defer cancel()
	result, err := s.Hub.CallResolved(ctx, target, cmd)
	if err == nil && artifact {
		result, err = s.saveArtifact(ctx, target, cmd, result)
	}
	if err != nil {
		replyError(w, cmd.ID, err)
		return
	}
	jsonOut(w, 200, Reply{ID: cmd.ID, Result: result})
}

func replyError(w http.ResponseWriter, id string, err error) {
	e := fault(err)
	code := 502
	switch e.Code {
	case "busy":
		code = 429
	case "browser_offline":
		code = 503
	case "outcome_unknown":
		code = 504
	case "wait_timeout":
		code = 408
	case "invalid_request", "invalid_args":
		code = 400
	case "stale_ref", "tab_busy", "session_busy", "session_browser":
		code = 409
	case "unsupported":
		code = 501
	}
	jsonOut(w, code, Reply{ID: id, Error: e})
}
func (s *Server) extension(w http.ResponseWriter, r *http.Request) {
	browser := originBrowser(r.Header.Get("Origin"))
	if browser == "" {
		http.Error(w, "extension origin required", 403)
		return
	}
	if s.Hub.ConnectedTo(browser) {
		http.Error(w, "a "+browser+" browser is already connected", 409)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"omw.v1"}, OriginPatterns: []string{"*"}, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer c.CloseNow()
	// The hello may exceed the 32 KiB default read limit; Attach raises the
	// limit to MaxMessage once the hello is answered.
	c.SetReadLimit(maxHello)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	helloCtx, helloCancel := context.WithTimeout(ctx, 5*time.Second)
	var hello Packet
	err = wsjson.Read(helloCtx, c, &hello)
	helloCancel()
	if err != nil || hello.Type != "hello" || hello.Protocol != Protocol {
		_ = c.Close(websocket.StatusPolicyViolation, "protocol mismatch")
		return
	}
	if reason := checkHello(hello, browser); reason != "" {
		_ = c.Close(websocket.StatusPolicyViolation, reason)
		return
	}
	if err = s.Hub.Attach(ctx, c, browser, hello.BrowserVersion, hello.Sessions); err != nil {
		if e := fault(err); e.Code == "browser_busy" {
			_ = c.Close(websocket.StatusPolicyViolation, e.Message)
		}
	}
}

// maxHello bounds the hello frame by the largest hello that checkHello
// accepts: MaxSessions names of up to 96 characters (sessionPattern), at most
// utf8.UTFMax bytes each, with two quotes and a comma per name, and a
// browserVersion of up to 128 bytes. 4 KiB covers the other fields and their
// names. The extensions encode the hello with JSON.stringify, which leaves
// these characters unescaped.
const maxHello = MaxSessions*(96*utf8.UTFMax+3) + 128 + 4<<10

// checkHello validates the extension's hello against its Origin. Extensions
// without a browser field are Chrome extensions from before Firefox support.
func checkHello(hello Packet, browser string) string {
	claimed := hello.Browser
	if claimed == "" {
		claimed = Chrome
	}
	if claimed != browser {
		return "hello browser does not match the extension origin"
	}
	if len(hello.BrowserVersion) > 128 {
		return "hello browserVersion exceeds 128 bytes"
	}
	if len(hello.Sessions) > MaxSessions {
		return "hello lists more than 128 sessions"
	}
	for _, name := range hello.Sessions {
		if !sessionPattern.MatchString(name) {
			return "hello lists an invalid session name"
		}
	}
	return ""
}

// Reject unusable explicit destinations before asking Chrome to render. The
// final hard link still provides atomic protection if another writer wins later.
func artifactPath(raw json.RawMessage) (string, error) {
	var args struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", &Fault{"invalid_args", "artifact path: " + err.Error()}
	}
	if args.Path != "" {
		if !filepath.IsAbs(args.Path) {
			return "", &Fault{"invalid_args", "artifact path must be absolute"}
		}
		if _, err := os.Lstat(args.Path); err == nil {
			return "", &Fault{"invalid_args", "artifact path already exists; choose a new path"}
		} else if !os.IsNotExist(err) {
			return "", &Fault{"invalid_args", "inspect artifact destination: " + err.Error()}
		}
	}
	return args.Path, nil
}

// saveArtifact writes the artifact of cmd, which browser returned.
func (s *Server) saveArtifact(ctx context.Context, browser string, cmd Command, result json.RawMessage) (json.RawMessage, error) {
	var artifact struct {
		Data      string `json:"data"`
		Stream    string `json:"stream"`
		Format    string `json:"format"`
		MIME      string `json:"mimeType"`
		PageTitle string `json:"pageTitle"`
	}
	if err := json.Unmarshal(result, &artifact); err != nil {
		return nil, err
	}
	if artifact.Stream != "" {
		defer func() {
			cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			raw, _ := json.Marshal(map[string]string{"handle": artifact.Stream})
			_, _ = s.Hub.Cleanup(cleanup, browser, Command{Action: "artifact_close", Session: cmd.Session, Args: raw})
		}()
	}
	target, err := artifactPath(cmd.Args)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(s.Config.Dir, "artifacts")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	ext := ".png"
	if artifact.Format == "jpeg" {
		ext = ".jpg"
	}
	if cmd.Action == "save_as_pdf" {
		ext = ".pdf"
	}
	if target == "" {
		target = filepath.Join(dir, NewID()+ext)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(filepath.Dir(target), ".omw-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	var total int64
	write := func(data string) error {
		n, err := io.Copy(f, io.LimitReader(base64.NewDecoder(base64.StdEncoding, strings.NewReader(data)), MaxArtifact-total+1))
		total += n
		if total > MaxArtifact {
			return fmt.Errorf("artifact exceeds 100 MiB")
		}
		return err
	}
	if artifact.Stream != "" {
		for {
			raw, _ := json.Marshal(map[string]string{"handle": artifact.Stream})
			r, err := s.Hub.CallResolved(ctx, browser, Command{Action: "artifact_read", Session: cmd.Session, Browser: cmd.Browser, Args: raw})
			if err != nil {
				return nil, err
			}
			var chunk struct {
				Data   string `json:"data"`
				EOF    bool   `json:"eof"`
				Base64 bool   `json:"base64Encoded"`
			}
			if err = json.Unmarshal(r, &chunk); err != nil {
				return nil, err
			}
			if chunk.Base64 {
				err = write(chunk.Data)
			} else {
				var n int
				n, err = io.WriteString(f, chunk.Data)
				total += int64(n)
				if total > MaxArtifact {
					err = fmt.Errorf("artifact exceeds 100 MiB")
				}
			}
			if err != nil {
				return nil, err
			}
			if chunk.EOF {
				break
			}
		}
	} else if err = write(artifact.Data); err != nil {
		return nil, err
	}
	if total == 0 {
		return nil, fmt.Errorf("empty artifact")
	}
	if err = f.Sync(); err != nil {
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	// Link refuses to overwrite an existing user file; temp and target share a filesystem.
	if err = os.Link(f.Name(), target); err != nil {
		return nil, fmt.Errorf("save artifact (existing paths are never overwritten): %w", err)
	}
	return json.Marshal(map[string]any{"path": target, "sizeBytes": total, "mimeType": artifact.MIME, "pageTitle": artifact.PageTitle})
}

func ParseCDP(endpoint string) (*url.URL, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return nil, fmt.Errorf("native CDP requires an explicit ws:// or wss:// browser endpoint")
	}
	if u.Host == "" || u.User != nil {
		return nil, fmt.Errorf("invalid native CDP endpoint")
	}
	return u, nil
}
