package server

import (
	"bytes"
	"context"
	"encoding/json"
	"labgate/internal/config"
	"labgate/internal/core"
	"labgate/internal/migration"
	"labgate/internal/store"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

type noopProvision struct{}

func (noopProvision) Issue(context.Context, core.Machine, string, int64, string) error { return nil }
func (noopProvision) Revoke(context.Context, core.Machine, string) error               { return nil }
func testServer(t *testing.T) *Server {
	p := filepath.Join(t.TempDir(), "db")
	if _, e := migration.Run(migration.Options{Path: p}); e != nil {
		t.Fatal(e)
	}
	db, e := store.Open(p)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	c := config.Defaults()
	c.Origin = "http://localhost:3000"
	c.Admins = []string{"admin@ubu.ac.th"}
	c.RegistrationSecret = store.Random(32)
	c.CronSecret = store.Random(32)
	return New(core.New(db, c, noopProvision{}), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("web")) }))
}
func session(t *testing.T, s *Server, email, kind string) string {
	t.Helper()
	raw, e := s.auth.createSession(context.Background(), User{Email: email, Name: "Test", Kind: kind})
	if e != nil {
		t.Fatal(e)
	}
	return raw
}
func request(s *Server, method, path, raw, kind string, b any, csrf bool) *httptest.ResponseRecorder {
	v, _ := json.Marshal(b)
	r := httptest.NewRequest(method, path, bytes.NewReader(v))
	if raw != "" {
		if kind == "cli" {
			r.Header.Set("Authorization", "Bearer "+raw)
		} else {
			r.AddCookie(&http.Cookie{Name: "labgate_session", Value: raw})
		}
	}
	if csrf {
		r.Header.Set("Origin", s.Core.Config.Origin)
		r.Header.Set("X-CSRF-Token", store.Hash(raw+"csrf"))
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}
func TestAdminAuthorizationAndCSRF(t *testing.T) {
	s := testServer(t)
	student := session(t, s, "student@ubu.ac.th", "web")
	admin := session(t, s, "admin@ubu.ac.th", "web")
	for _, v := range []struct {
		raw  string
		want int
	}{{"", 401}, {student, 403}, {admin, 200}} {
		w := request(s, "GET", "/api/admin/machines", v.raw, "web", nil, false)
		if w.Code != v.want {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	identity := core.Identity{Name: "Desktop", IP: "100.64.0.1", Pin: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
	if w := request(s, "POST", "/api/admin/register-machine", admin, "web", identity, false); w.Code != 403 {
		t.Fatal("CSRF accepted", w.Code)
	}
	w := request(s, "POST", "/api/admin/register-machine", admin, "web", identity, true)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	inventory := request(s, "GET", "/api/admin/machines", admin, "web", nil, false)
	if bytes.Contains(inventory.Body.Bytes(), []byte(out["webhookToken"].(string))) {
		t.Fatal("token exposed in inventory")
	}
	if w = request(s, "GET", "/admin", student, "web", nil, false); w.Code != 302 || w.Header().Get("Location") != "/" {
		t.Fatal("admin page accessible")
	}
}

func TestLegacyEnrollmentWireRecords(t *testing.T) {
	s := testServer(t)
	w := request(s, "GET", "/api/health", "", "", nil, false)
	if string(bytes.TrimSpace(w.Body.Bytes())) != `{"ok":true,"service":"labgate","machineEnrollmentVersion":1}` {
		t.Fatal("legacy installer rejects health record", w.Body.String())
	}
	r := httptest.NewRequest("GET", "/api/admin/register-machine", nil)
	r.Header.Set("Authorization", "Bearer "+s.Core.Config.RegistrationSecret)
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 200 || string(bytes.TrimSpace(w.Body.Bytes())) != `{"ok":true,"service":"labgate","machineEnrollmentVersion":1,"registrationReady":true}` {
		t.Fatal("legacy installer rejects readiness record", w.Code, w.Body.String())
	}
}
func TestPairingApprovalReplayAndRevocation(t *testing.T) {
	s := testServer(t)
	secret := store.Random(32)
	w := request(s, "POST", "/api/cli/start", "", "", map[string]string{"secret": secret}, false)
	var pair struct{ ID, Code string }
	json.Unmarshal(w.Body.Bytes(), &pair)
	if w.Code != 200 || pair.ID == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = request(s, "POST", "/api/cli/poll", "", "", map[string]string{"id": pair.ID, "secret": store.Random(32)}, false); w.Code != 400 {
		t.Fatal("wrong secret accepted")
	}
	student := session(t, s, "s@ubu.ac.th", "web")
	if w = request(s, "POST", "/api/cli/approve", student, "web", map[string]string{"code": pair.Code}, true); w.Code != 403 {
		t.Fatal("student approved pairing")
	}
	admin := session(t, s, "admin@ubu.ac.th", "web")
	if w = request(s, "POST", "/api/cli/approve", admin, "web", map[string]string{"code": pair.Code}, true); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(s, "POST", "/api/cli/poll", "", "", map[string]string{"id": pair.ID, "secret": secret}, false)
	var out struct{ Token string }
	json.Unmarshal(w.Body.Bytes(), &out)
	if w.Code != 200 || out.Token == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = request(s, "POST", "/api/cli/poll", "", "", map[string]string{"id": pair.ID, "secret": secret}, false); w.Code != 400 {
		t.Fatal("pair replay accepted")
	}
	if w = request(s, "GET", "/api/admin/machines", out.Token, "cli", nil, false); w.Code != 200 {
		t.Fatal(w.Code)
	}
	request(s, "POST", "/api/auth/sign-out", out.Token, "cli", map[string]any{}, false)
	if w = request(s, "GET", "/api/admin/machines", out.Token, "cli", nil, false); w.Code != 401 {
		t.Fatal("logout did not revoke token")
	}
}
func TestWebhookAcknowledgesUnknownAndRejectsVersion(t *testing.T) {
	s := testServer(t)
	token := store.Random(32)
	id := store.ID()
	s.Core.Store.DB.Exec("INSERT INTO machines(id,name,tailscale_ip,webhook_token,status) VALUES(?,?,?,?,'offline')", id, "Machine", "100.64.0.1", token)
	report := map[string]any{"credentialId": store.ID(), "stateVersion": 2}
	v, _ := json.Marshal(report)
	req := httptest.NewRequest("POST", "/api/webhook/session-open", bytes.NewReader(v))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	report["stateVersion"] = 3
	v, _ = json.Marshal(report)
	req = httptest.NewRequest("POST", "/api/webhook/session-open", bytes.NewReader(v))
	req.Header.Set("Authorization", "Bearer "+token)
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatal("wrong endpoint version accepted")
	}
}
func TestOAuthStateReplayAndDomainSession(t *testing.T) {
	s := testServer(t)
	w := request(s, "GET", "/api/auth/sign-in/google", "", "", nil, false)
	if w.Code != 302 {
		t.Fatal(w.Code)
	}
	var state string
	for _, c := range w.Result().Cookies() {
		if c.Name == "labgate_oauth" {
			state = c.Value
		}
	}
	if state == "" {
		t.Fatal("missing state cookie")
	}
	r := httptest.NewRequest("GET", "/api/auth/callback/google?state="+state+"&code=invalid", nil)
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("unbound state accepted")
	}
	foreign := session(t, s, "user@example.com", "web")
	if w = request(s, "GET", "/api/machines", foreign, "web", nil, false); w.Code != 401 {
		t.Fatal("foreign session accepted")
	}
	expired := session(t, s, "a@ubu.ac.th", "web")
	s.Core.Store.DB.Exec("UPDATE go_sessions SET expires_at=? WHERE token_hash=?", time.Now().Add(-time.Hour).UnixMilli(), store.Hash(expired))
	if w = request(s, "GET", "/api/machines", expired, "web", nil, false); w.Code != 401 {
		t.Fatal("expired session accepted")
	}
}

// Unauthenticated health probes must not each run full database validation.
func TestHealthProbesShareOneValidation(t *testing.T) {
	s := testServer(t)
	for i := 0; i < 5; i++ {
		if w := request(s, "GET", "/api/health", "", "", nil, false); w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	first := s.healthAt
	if first.IsZero() {
		t.Fatal("health result not recorded")
	}
	if _, e := s.Core.Store.DB.Exec("DROP INDEX audit_log_created_at_id_idx"); e != nil {
		t.Fatal(e)
	}
	if w := request(s, "GET", "/api/health", "", "", nil, false); w.Code != 200 || s.healthAt != first {
		t.Fatal("probe inside the interval reran full validation")
	}
	s.healthAt = first.Add(-healthInterval)
	if w := request(s, "GET", "/api/health", "", "", nil, false); w.Code != 503 {
		t.Fatal("expired health result did not revalidate", w.Code)
	}
}

func TestRegistrationSecretCannotRekey(t *testing.T) {
	s := testServer(t)
	admin := session(t, s, "admin@ubu.ac.th", "web")
	pin := "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	identity := core.Identity{Name: "Desktop", IP: "100.64.0.1", Pin: pin}
	w := request(s, "POST", "/api/admin/register-machine", admin, "web", identity, true)
	var first map[string]any
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &first) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	token, _ := first["webhookToken"].(string)
	var id string
	if e := s.Core.Store.DB.QueryRow("SELECT id FROM machines WHERE webhook_token=?", token).Scan(&id); e != nil || token == "" {
		t.Fatal("enrolled machine not found", e)
	}
	if _, e := s.Core.Store.DB.Exec("UPDATE machines SET status='available' WHERE id=?", id); e != nil {
		t.Fatal(e)
	}
	secret := func(method string, b any) *httptest.ResponseRecorder {
		v, _ := json.Marshal(b)
		r := httptest.NewRequest(method, "/api/admin/register-machine", bytes.NewReader(v))
		r.Header.Set("Authorization", "Bearer "+s.Core.Config.RegistrationSecret)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	rekey := core.Identity{Name: "Desktop", IP: "100.64.0.99", Pin: "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA", MachineID: id, ExpectedName: "Desktop", ExpectedIP: "100.64.0.1", ExpectedPin: &pin}
	if w := secret("PATCH", rekey); w.Code != 403 {
		t.Fatal("registration secret rekeyed a machine", w.Code, w.Body.String())
	}
	var ip, stored string
	if e := s.Core.Store.DB.QueryRow("SELECT tailscale_ip,webhook_token FROM machines WHERE id=?", id).Scan(&ip, &stored); e != nil || ip != "100.64.0.1" || stored != token {
		t.Fatal("machine identity changed", ip, e)
	}
	var again map[string]any
	if w := secret("POST", identity); w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &again) != nil || again["webhookToken"] != token {
		t.Fatal("idempotent enrollment broken", w.Code, w.Body.String())
	}
	if w := request(s, "PATCH", "/api/admin/register-machine", admin, "web", rekey, true); w.Code != 200 {
		t.Fatal("admin rekey broken", w.Code, w.Body.String())
	}
}
