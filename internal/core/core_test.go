package core

import (
	"context"
	"database/sql"
	"errors"
	"labgate/internal/config"
	"labgate/internal/migration"
	"labgate/internal/store"
	"net/url"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type fakeProvision struct {
	issue  func(context.Context, Machine, string, int64, string) error
	revoke func(context.Context, Machine, string) error
}

func (f fakeProvision) Issue(c context.Context, m Machine, id string, d int64, p string) error {
	if f.issue != nil {
		return f.issue(c, m, id, d, p)
	}
	return nil
}
func (f fakeProvision) Revoke(c context.Context, m Machine, id string) error {
	if f.revoke != nil {
		return f.revoke(c, m, id)
	}
	return nil
}

const testPin = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func fixture(t *testing.T) *Service {
	t.Helper()
	p := filepath.Join(t.TempDir(), "test.db")
	if _, e := migration.Run(migration.Options{Path: p}); e != nil {
		t.Fatal(e)
	}
	db, e := store.Open(p)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	cfg := config.Defaults()
	cfg.Admins = []string{"admin@ubu.ac.th"}
	s := New(db, cfg, fakeProvision{})
	s.Now = func() time.Time { return time.Unix(1800000000, 0) }
	return s
}
func seed(t *testing.T, s *Service) (string, string) {
	t.Helper()
	id, token := store.ID(), store.Random(32)
	_, e := s.Store.DB.Exec("INSERT INTO machines(id,name,tailscale_ip,ssh_host_key_sha256,webhook_token,status,last_heartbeat) VALUES(?,?,?,?,?,'available',?)", id, "Desktop", "100.64.0.1", testPin, token, store.Time(s.Now()))
	if e != nil {
		t.Fatal(e)
	}
	return id, token
}
func creds(t *testing.T, s *Service, mid string) Credential {
	t.Helper()
	var id string
	if e := s.Store.DB.QueryRow("SELECT id FROM guest_credentials WHERE machine_id=? ORDER BY created_at DESC LIMIT 1", mid).Scan(&id); e != nil {
		t.Fatal(e)
	}
	c, e := credential(context.Background(), s.Store.DB, id)
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func report(id string, state string) Report {
	ver := versionFor(state)
	locked := state == "revoked"
	active := state == "active"
	return Report{ID: &id, State: &state, Version: &ver, Locked: &locked, Active: &active}
}
func versionFor(v string) int {
	if v == "active" {
		return 2
	}
	if v == "revoked" {
		return 3
	}
	return 1
}
func TestConcurrentCheckout(t *testing.T) {
	s := fixture(t)
	id, _ := seed(t, s)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, email := range []string{"a@ubu.ac.th", "b@ubu.ac.th"} {
		wg.Add(1)
		go func(e string) { defer wg.Done(); _, err := s.Checkout(context.Background(), id, e); errs <- err }(email)
	}
	wg.Wait()
	close(errs)
	success, conflict := 0, 0
	for e := range errs {
		if e == nil {
			success++
		} else {
			var v *Error
			if errors.As(e, &v) && v.Status == 409 {
				conflict++
			} else {
				t.Fatal(e)
			}
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}
}
func TestActiveSurvivesDeadlineAndCloses(t *testing.T) {
	s := fixture(t)
	mid, token := seed(t, s)
	if _, e := s.Checkout(context.Background(), mid, "a@ubu.ac.th"); e != nil {
		t.Fatal(e)
	}
	c := creds(t, s, mid)
	if status, e := s.Webhook(context.Background(), token, "session-open", report(c.ID, "active")); e != nil || status != "activated" {
		t.Fatal(status, e)
	}
	if _, e := s.Webhook(context.Background(), token, "heartbeat", report(c.ID, "active")); e != nil {
		t.Fatal(e)
	}
	s.Now = func() time.Time { return time.UnixMilli(c.Expires + 10000) }
	calls := 0
	s.Provision = fakeProvision{revoke: func(context.Context, Machine, string) error { calls++; return nil }}
	v, e := s.Sweep(context.Background())
	if e != nil || calls != 0 || v.Active != 1 {
		t.Fatal(v, calls, e)
	}
	if _, e = s.Webhook(context.Background(), token, "session-close", report(c.ID, "revoked")); e != nil {
		t.Fatal(e)
	}
	m, _ := machine(context.Background(), s.Store.DB, mid)
	if m.Status != "available" || m.Hold != nil {
		t.Fatal(m)
	}
}
func TestExpiryLockAndCompensation(t *testing.T) {
	for _, lockFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirmed", true: "unreachable"}[lockFails], func(t *testing.T) {
			s := fixture(t)
			mid, _ := seed(t, s)
			s.Provision = fakeProvision{issue: func(context.Context, Machine, string, int64, string) error { return errors.New("issue failed") }, revoke: func(context.Context, Machine, string) error {
				if lockFails {
					return errors.New("unreachable")
				}
				return nil
			}}
			v, e := s.Checkout(context.Background(), mid, "a@ubu.ac.th")
			if e == nil || v.Password != "" {
				t.Fatal("failed provisioning disclosed password")
			}
			m, _ := machine(context.Background(), s.Store.DB, mid)
			c := creds(t, s, mid)
			if lockFails {
				if m.Status != "occupied" || m.Hold == nil || *m.Hold != c.ID || c.Revoked.Valid {
					t.Fatal(m, c)
				}
			} else if m.Status != "available" || !c.Revoked.Valid {
				t.Fatal(m, c)
			}
		})
	}
}
func TestExpiryRaceWithOpen(t *testing.T) {
	s := fixture(t)
	mid, token := seed(t, s)
	s.Checkout(context.Background(), mid, "a@ubu.ac.th")
	c := creds(t, s, mid)
	s.Now = func() time.Time { return time.UnixMilli(c.Expires + 1) }
	s.Provision = fakeProvision{revoke: func(context.Context, Machine, string) error {
		_, e := s.Webhook(context.Background(), token, "session-open", report(c.ID, "active"))
		return e
	}}
	v, e := s.Expire(context.Background(), c.ID)
	if e != nil || v.Status != "active" || v.Released {
		t.Fatal(v, e)
	}
}
func TestUnexpectedGenerationAndUnrelatedClose(t *testing.T) {
	s := fixture(t)
	mid, token := seed(t, s)
	s.Checkout(context.Background(), mid, "a@ubu.ac.th")
	c := creds(t, s, mid)
	unknown := store.ID()
	if _, e := s.Webhook(context.Background(), token, "session-open", report(unknown, "active")); e != nil {
		t.Fatal(e)
	}
	m, _ := machine(context.Background(), s.Store.DB, mid)
	if m.Hold == nil || *m.Hold != ConflictHold {
		t.Fatal(m)
	}
	s.Webhook(context.Background(), token, "session-close", report(c.ID, "revoked"))
	m, _ = machine(context.Background(), s.Store.DB, mid)
	if m.Status != "occupied" || m.Hold == nil {
		t.Fatal("unrelated close released hold")
	}
	locked, active := true, false
	_, e := s.Webhook(context.Background(), token, "heartbeat", Report{Locked: &locked, Active: &active})
	if e != nil {
		t.Fatal(e)
	}
	m, _ = machine(context.Background(), s.Store.DB, mid)
	if m.Status != "available" || m.Hold != nil {
		t.Fatal(m)
	}
}
func TestEnrollmentAndRekeyCAS(t *testing.T) {
	s := fixture(t)
	ctx := context.Background()
	identity := Identity{Name: "Machine", IP: "100.64.0.2", Pin: testPin}
	out, e := s.Enroll(ctx, identity, false, "admin@ubu.ac.th")
	if e != nil {
		t.Fatal(e)
	}
	sameOut, e := s.Enroll(ctx, identity, false, "")
	if e != nil || out["webhookToken"] != sameOut["webhookToken"] {
		t.Fatal(sameOut, e)
	}
	var id string
	s.Store.DB.QueryRow("SELECT id FROM machines").Scan(&id)
	m, _ := machine(ctx, s.Store.DB, id)
	if m.Status != "offline" || m.Heartbeat != nil {
		t.Fatal(m)
	}
	identity.MachineID = id
	identity.ExpectedName = m.Name
	identity.ExpectedIP = m.IP
	identity.ExpectedPin = m.Pin
	if _, e = s.Enroll(ctx, identity, true, ""); e == nil {
		t.Fatal("offline rekey accepted")
	}
	locked, active := true, false
	s.Webhook(ctx, m.Token, "heartbeat", Report{Locked: &locked, Active: &active})
	if _, e = s.Enroll(ctx, identity, true, ""); e != nil {
		t.Fatal(e)
	}
	m2, _ := machine(ctx, s.Store.DB, id)
	if m2.Token == m.Token || m2.Status != "offline" {
		t.Fatal(m2)
	}
}
func TestHiddenStaleAndPassword(t *testing.T) {
	for _, kind := range []string{"hidden", "stale", "held"} {
		t.Run(kind, func(t *testing.T) {
			s := fixture(t)
			mid, _ := seed(t, s)
			switch kind {
			case "hidden":
				s.Visibility(context.Background(), mid, true, "admin@ubu.ac.th")
			case "stale":
				s.Store.DB.Exec("UPDATE machines SET last_heartbeat=0")
			case "held":
				s.Store.DB.Exec("UPDATE machines SET safety_hold_credential_id=?", store.ID())
			}
			if _, e := s.Checkout(context.Background(), mid, "a@ubu.ac.th"); e == nil {
				t.Fatal("unsafe checkout accepted")
			}
		})
	}
	for _, n := range []int{5, 8, 128} {
		p, e := Password(n)
		if e != nil || len(p) != n {
			t.Fatal(n, e)
		}
	}
}
func TestActivityPaginationAndSecrets(t *testing.T) {
	s := fixture(t)
	mid, _ := seed(t, s)
	s.Store.Tx(context.Background(), func(tx *sql.Tx) error {
		for i := 0; i < 53; i++ {
			if e := Audit(context.Background(), tx, mid, "a@ubu.ac.th", "checkout", "sensitive internal detail", store.Time(s.Now())); e != nil {
				return e
			}
		}
		return nil
	})
	p, e := s.Activity(context.Background(), url.Values{})
	if e != nil || len(p.Entries) != 50 || p.Cursor == nil {
		t.Fatal(p, e)
	}
	q, e := s.Activity(context.Background(), url.Values{"cursor": {*p.Cursor}})
	if e != nil || len(q.Entries) != 3 {
		t.Fatal(q, e)
	}
	ids := map[string]bool{}
	for _, x := range append(p.Entries, q.Entries...) {
		if ids[x.ID] {
			t.Fatal("duplicate pagination row")
		}
		ids[x.ID] = true
	}
	if _, e = s.Activity(context.Background(), url.Values{"source": {"all", "web"}}); e == nil {
		t.Fatal("duplicate filter accepted")
	}
}
