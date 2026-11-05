package bridge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-webbridge/oh-my-webbridge/internal/config"
)

const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

func pairingServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	s := New(config.Config{Token: strings.Repeat("b", 64), Dir: t.TempDir()})
	server := httptest.NewServer(s.Handler())
	t.Cleanup(server.Close)
	t.Cleanup(s.Hub.Close)
	return s, server
}

func pairingCall(t *testing.T, server *httptest.Server, method, path, body, token, origin string, out any) int {
	t.Helper()
	req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil && strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		if err = json.NewDecoder(res.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
	return res.StatusCode
}

func TestPairingCodeHandsOutTheTokenOnce(t *testing.T) {
	s, server := pairingServer(t)
	var started struct {
		Code    string `json:"code"`
		Expires int    `json:"expires_in_seconds"`
	}
	if code := pairingCall(t, server, "POST", "/pairing", "", s.Config.Token, "", &started); code != 200 {
		t.Fatalf("start pairing: HTTP %d", code)
	}
	if len(started.Code) != 6 || started.Expires != 300 {
		t.Fatalf("unexpected pairing code %+v", started)
	}
	wrong := "000000"
	if started.Code == wrong {
		wrong = "111111"
	}
	if code := pairingCall(t, server, "POST", "/pair", `{"code":"`+wrong+`"}`, "", extensionOrigin, nil); code != 401 {
		t.Fatalf("wrong code: HTTP %d", code)
	}
	var state PairingState
	pairingCall(t, server, "GET", "/pairing", "", s.Config.Token, "", &state)
	if state.State != "pending" {
		t.Fatalf("state after a wrong guess: %+v", state)
	}
	var paired struct {
		Token string `json:"token"`
	}
	if code := pairingCall(t, server, "POST", "/pair", `{"code":"`+started.Code+`"}`, "", extensionOrigin, &paired); code != 200 || paired.Token != s.Config.Token {
		t.Fatalf("redeem: HTTP %d, token %q", code, paired.Token)
	}
	if code := pairingCall(t, server, "POST", "/pair", `{"code":"`+started.Code+`"}`, "", extensionOrigin, nil); code != 401 {
		t.Fatalf("second redeem: HTTP %d", code)
	}
	pairingCall(t, server, "GET", "/pairing", "", s.Config.Token, "", &state)
	if state.State != "paired" || state.Browser != Chrome {
		t.Fatalf("state after pairing: %+v", state)
	}
}

func TestPairingEndpointsRequireTheirCallers(t *testing.T) {
	s, server := pairingServer(t)
	cases := []struct {
		method, path, token, origin string
		status                      int
	}{
		{"GET", "/ping", "", extensionOrigin, 200},
		{"GET", "/ping", "", "moz-extension://12345678-1234-1234-1234-123456789abc", 200},
		{"GET", "/ping", "", "", 200},
		{"GET", "/ping", "", "https://evil.test", 403},
		{"POST", "/pair", "", "", 403},
		{"POST", "/pair", "", "https://evil.test", 403},
		{"POST", "/pairing", "", "", 401},
		{"POST", "/pairing", s.Config.Token, extensionOrigin, 403},
		{"GET", "/pairing", "", "", 401},
	}
	for _, tc := range cases {
		if code := pairingCall(t, server, tc.method, tc.path, `{"code":"123456"}`, tc.token, tc.origin, nil); code != tc.status {
			t.Errorf("%s %s origin %q: got %d want %d", tc.method, tc.path, tc.origin, code, tc.status)
		}
	}
}

func TestPairingCodeStopsAfterRepeatedGuessesOrExpiry(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	p := pairing{now: func() time.Time { return now }}
	code, _, err := p.start()
	if err != nil {
		t.Fatal(err)
	}
	wrong := "000000"
	if code == wrong {
		wrong = "111111"
	}
	for range pairingAttempts {
		if p.redeem(wrong, Chrome) {
			t.Fatal("accepted a wrong code")
		}
	}
	if p.redeem(code, Chrome) || p.state().State != "expired" {
		t.Fatalf("code still works after %d wrong guesses", pairingAttempts)
	}
	code, _, err = p.start()
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(pairingTTL)
	if p.redeem(code, Chrome) || p.state().State != "expired" {
		t.Fatal("code still works after it expired")
	}
}
