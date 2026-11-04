package bridge

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"sync"
	"time"
)

// Pairing hands the extension its token through a short code that the user
// reads in a terminal. `omw pair` asks the authenticated API for a code; the
// extension submits it once from its own origin and receives the token.
const (
	pairingTTL      = 5 * time.Minute
	pairingAttempts = 5
)

type pairing struct {
	mu       sync.Mutex
	code     string
	expires  time.Time
	attempts int
	// browser names the extension that redeemed the latest code.
	browser string
	now     func() time.Time
}

// PairingState is what `omw pair` polls while it waits for the extension.
type PairingState struct {
	State   string `json:"state"`
	Browser string `json:"browser,omitempty"`
}

// start replaces any pending code with a new six-digit code.
func (p *pairing) start() (string, time.Duration, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", 0, fmt.Errorf("generate pairing code: %w", err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.code = fmt.Sprintf("%06d", n.Int64())
	p.expires = p.now().Add(pairingTTL)
	p.attempts = 0
	p.browser = ""
	return p.code, pairingTTL, nil
}

func (p *pairing) state() PairingState {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch {
	case p.browser != "":
		return PairingState{State: "paired", Browser: p.browser}
	case p.code != "" && p.now().Before(p.expires):
		return PairingState{State: "pending"}
	}
	return PairingState{State: "expired"}
}

// redeem accepts the pending code once. A code that expires or receives
// pairingAttempts wrong guesses stops working.
func (p *pairing) redeem(code, browser string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.code == "" || !p.now().Before(p.expires) {
		p.code = ""
		return false
	}
	if subtle.ConstantTimeCompare([]byte(code), []byte(p.code)) != 1 {
		p.attempts++
		if p.attempts >= pairingAttempts {
			p.code = ""
		}
		return false
	}
	p.code = ""
	p.browser = browser
	return true
}

// ping lets the extension see a running daemon before it has a token.
func (s *Server) ping(w http.ResponseWriter, r *http.Request) {
	jsonOut(w, 200, map[string]any{"name": "oh-my-webbridge", "version": Version, "protocol": Protocol})
}

func (s *Server) startPairing(w http.ResponseWriter, r *http.Request) {
	code, ttl, err := s.pairing.start()
	if err != nil {
		jsonOut(w, 500, Reply{Error: &Fault{Code: "internal", Message: err.Error()}})
		return
	}
	jsonOut(w, 200, map[string]any{"code": code, "expires_in_seconds": int(ttl.Seconds())})
}

func (s *Server) pairingState(w http.ResponseWriter, r *http.Request) {
	jsonOut(w, 200, s.pairing.state())
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&body); err != nil {
		jsonOut(w, 400, Reply{Error: &Fault{Code: "invalid_request", Message: "expected {\"code\": \"123456\"}"}})
		return
	}
	if !s.pairing.redeem(body.Code, originBrowser(r.Header.Get("Origin"))) {
		jsonOut(w, 401, Reply{Error: &Fault{Code: "pairing_failed", Message: "the code is wrong or expired; run omw pair for a new one"}})
		return
	}
	jsonOut(w, 200, map[string]string{"token": s.Config.Token})
}
