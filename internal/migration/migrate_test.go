package migration

import (
	"database/sql"
	"labgate/internal/store"
	"os"
	"path/filepath"
	"testing"
)

func TestFreshExplicitAndRunningWriter(t *testing.T) {
	p := filepath.Join(t.TempDir(), "db")
	if _, e := store.Open(p); e == nil {
		t.Fatal("missing database accepted")
	}
	if _, e := os.Stat(p); !os.IsNotExist(e) {
		t.Fatal("application created database")
	}
	if _, e := Run(Options{Path: p, DryRun: true}); e != nil {
		t.Fatal(e)
	}
	entries, _ := os.ReadDir(filepath.Dir(p))
	if len(entries) != 0 {
		t.Fatal("dry run mutated filesystem")
	}
	if _, e := Run(Options{Path: p}); e != nil {
		t.Fatal(e)
	}
	s, e := store.Open(p)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if _, e = Run(Options{Path: p}); e == nil {
		t.Fatal("migration accepted a running application")
	}
}
func TestLegacyMigration(t *testing.T) {
	p := filepath.Join(t.TempDir(), "db")
	d, e := sql.Open("sqlite", p)
	if e != nil {
		t.Fatal(e)
	}
	sqlText, e := os.ReadFile("../../tests/fixtures/legacy-domain.sql")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = d.Exec(string(sqlText)); e != nil {
		t.Fatal(e)
	}
	_, e = d.Exec(`INSERT INTO machines(id,name,tailscale_ip,webhook_token,status,last_heartbeat) VALUES('machine_abcdefghijklmnop','Desktop','100.64.0.1','abcdefghijklmnopqrstuvwx','occupied','2026-10-02T12:00:00.000Z'); INSERT INTO guest_credentials(id,machine_id,student_email,created_at,expires_at) VALUES('credential_abcdefghijklmnop','machine_abcdefghijklmnop','a@ubu.ac.th','2026-10-02 12:00:00','2026-10-02T12:03:00Z');`)
	if e != nil {
		t.Fatal(e)
	}
	d.Close()
	if _, e = Run(Options{Path: p}); e != nil {
		t.Fatal(e)
	}
	s, e := store.Open(p)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	var n int
	var expiry int64
	if e = s.DB.QueryRow("SELECT COUNT(*),expires_at FROM guest_credentials").Scan(&n, &expiry); e != nil || n != 1 || expiry != 1790942580000 {
		t.Fatal(n, expiry, e)
	}
	var status string
	s.DB.QueryRow("SELECT status FROM machines").Scan(&status)
	if status != "occupied" {
		t.Fatal("migration released reservation")
	}
	backups, _ := filepath.Glob(p + ".backup-*")
	if len(backups) != 1 {
		t.Fatal("backup missing")
	}
}
func TestUnsafeMigrationRollsBack(t *testing.T) {
	p := filepath.Join(t.TempDir(), "db")
	Run(Options{Path: p})
	d, _ := sql.Open("sqlite", p)
	d.Exec("INSERT INTO machines(id,name,tailscale_ip,webhook_token,status,safety_hold_credential_id) VALUES('abcdefghijklmnopqrst','Desktop','100.64.0.1','abcdefghijklmnopqrstuvwx','available','unsafe-generation')")
	d.Close()
	if _, e := Run(Options{Path: p}); e == nil {
		t.Fatal("unsafe database accepted")
	}
	d, _ = sql.Open("sqlite", p)
	defer d.Close()
	var status, hold string
	d.QueryRow("SELECT status,safety_hold_credential_id FROM machines").Scan(&status, &hold)
	if status != "available" || hold != "unsafe-generation" {
		t.Fatal("migration silently repaired unsafe data")
	}
}
func TestLegacyTimestamps(t *testing.T) {
	for _, v := range []string{"1790942400000", "2026-10-02T12:00:00.000Z", "2026-10-02 12:00:00", "2026-10-02 12:00:00+00:00"} {
		n, e := ParseTime(v)
		if e != nil || n != 1790942400000 {
			t.Fatal(v, n, e)
		}
	}
	if _, e := ParseTime("garbage"); e == nil {
		t.Fatal("corrupt timestamp accepted")
	}
}

func TestFailedLegacyUpgradeLeavesNoPartialSchema(t *testing.T) {
	p := filepath.Join(t.TempDir(), "db")
	d, _ := sql.Open("sqlite", p)
	fixture, _ := os.ReadFile("../../tests/fixtures/legacy-domain.sql")
	if _, err := d.Exec(string(fixture)); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO machines(id,name,tailscale_ip,webhook_token,status,last_heartbeat) VALUES('machine_abcdefghijklmnop','Desktop','100.64.0.1','abcdefghijklmnopqrstuvwx','offline','broken-timestamp')`); err != nil {
		t.Fatal(err)
	}
	d.Close()
	if _, err := Run(Options{Path: p, DryRun: true}); err == nil {
		t.Fatal("dry run failed to catch invalid legacy data")
	}
	if _, err := Run(Options{Path: p}); err == nil {
		t.Fatal("invalid migration succeeded")
	}
	d, _ = sql.Open("sqlite", p)
	defer d.Close()
	var count int
	d.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name IN ('go_sessions','labgate_schema','machines_name_key')`).Scan(&count)
	if count != 0 {
		t.Fatal("failed migration left partial schema")
	}
	var heartbeat string
	d.QueryRow(`SELECT last_heartbeat FROM machines`).Scan(&heartbeat)
	if heartbeat != "broken-timestamp" {
		t.Fatal("failed migration modified legacy data")
	}
}
