package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"labgate/internal/config"
	_ "modernc.org/sqlite"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const Version = 1

type Store struct {
	DB   *sql.DB
	lock *os.File
	mu   sync.Mutex
}

func Open(path string) (*Store, error) {
	s, e := os.Stat(path)
	if e != nil || !s.Mode().IsRegular() {
		return nil, fmt.Errorf("database is missing; run labgate-migrate --database %q explicitly", path)
	}
	l, e := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = unix.Flock(int(l.Fd()), unix.LOCK_SH|unix.LOCK_NB); e != nil {
		l.Close()
		return nil, errors.New("database migration is in progress")
	}
	abs, _ := filepath.Abs(path)
	d, e := sql.Open("sqlite", "file:"+url.PathEscape(abs)+"?mode=rw&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if e != nil {
		l.Close()
		return nil, e
	}
	d.SetMaxOpenConns(1)
	v := &Store{DB: d, lock: l}
	if e = v.Validate(); e != nil {
		v.Close()
		return nil, e
	}
	return v, nil
}
func (s *Store) Close() error {
	e := s.DB.Close()
	if s.lock != nil {
		s.lock.Close()
	}
	return e
}
func (s *Store) Validate() error {
	var v int
	if e := s.DB.QueryRow("SELECT version FROM labgate_schema WHERE id=1").Scan(&v); e != nil || v != Version {
		return errors.New("incompatible database schema; stop writers and run labgate-migrate explicitly")
	}
	return ValidateDomain(s.DB)
}

type Querier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func ValidateDomain(d *sql.DB) error { return ValidateQuery(context.Background(), d) }
func ValidateQuery(ctx context.Context, d Querier) error {
	// Read every required column before accepting a version marker as ready.
	for _, query := range []string{
		`SELECT id,name,tailscale_ip,webhook_token,status,last_heartbeat,ssh_host_key_sha256,safety_hold_credential_id,is_hidden FROM machines LIMIT 0`,
		`SELECT id,machine_id,student_email,created_at,expires_at,revoked_at,session_opened_at,machine_state_version FROM guest_credentials LIMIT 0`,
		`SELECT id,machine_id,student_email,event,detail,created_at FROM audit_log LIMIT 0`,
		`SELECT id,name,email,emailVerified,createdAt,updatedAt FROM user LIMIT 0`,
		`SELECT token_hash,email,name,expires_at,kind FROM go_sessions LIMIT 0`,
		`SELECT id,secret_hash,code,expires_at,email,name,approved_at FROM go_pairings LIMIT 0`,
		`SELECT state_hash,nonce,verifier,expires_at FROM go_oauth LIMIT 0`,
	} {
		rows, err := d.QueryContext(ctx, query)
		if err != nil {
			return errors.New("required database schema is incomplete; stop writers and run labgate-migrate explicitly")
		}
		if err = rows.Close(); err != nil {
			return err
		}
	}
	checks := []string{
		`SELECT COUNT(*) FROM (SELECT machine_id FROM guest_credentials WHERE revoked_at IS NULL GROUP BY machine_id HAVING COUNT(*)>1)`,
		`SELECT COUNT(*) FROM (SELECT LOWER(student_email) FROM guest_credentials WHERE revoked_at IS NULL GROUP BY LOWER(student_email) HAVING COUNT(*)>1)`,
		`SELECT COUNT(*) FROM machines m WHERE status='available' AND (safety_hold_credential_id IS NOT NULL OR EXISTS(SELECT 1 FROM guest_credentials c WHERE c.machine_id=m.id AND c.revoked_at IS NULL))`,
		`SELECT COUNT(*) FROM machines WHERE status NOT IN ('available','occupied','offline')`,
	}
	for _, q := range checks {
		var n int
		if e := d.QueryRowContext(ctx, q).Scan(&n); e != nil {
			return e
		}
		if n != 0 {
			return errors.New("unsafe database state: reconcile duplicate credentials, status, or safety holds before startup")
		}
	}
	var result string
	if e := d.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&result); e != nil || result != "ok" {
		return errors.New("database integrity check failed")
	}
	r, e := d.QueryContext(ctx, "PRAGMA foreign_key_check")
	if e != nil {
		return e
	}
	if r.Next() {
		r.Close()
		return errors.New("foreign key check failed")
	}
	e = r.Err()
	r.Close()
	if e != nil {
		return e
	}
	for _, name := range []string{"machines_name_key", "machines_tailscale_ip_key", "machines_webhook_token_key", "machines_ssh_host_key_sha256_key", "guest_credentials_active_machine_key", "guest_credentials_active_student_email_key", "audit_log_created_at_id_idx"} {
		var statement string
		if e = d.QueryRowContext(ctx, "SELECT sql FROM sqlite_master WHERE type='index' AND name=?", name).Scan(&statement); e != nil {
			return fmt.Errorf("required index missing: %s", name)
		}
		normalized := strings.ToLower(strings.Join(strings.Fields(strings.ReplaceAll(statement, `"`, "")), " "))
		if name != "audit_log_created_at_id_idx" && !strings.Contains(normalized, "unique index") {
			return errors.New("required unique index is not unique")
		}
		expected := map[string]string{
			"machines_name_key": "machines(name)", "machines_tailscale_ip_key": "machines(tailscale_ip)",
			"machines_webhook_token_key": "machines(webhook_token)", "machines_ssh_host_key_sha256_key": "machines(ssh_host_key_sha256)",
			"guest_credentials_active_machine_key":       "guest_credentials(machine_id)whererevoked_atisnull",
			"guest_credentials_active_student_email_key": "guest_credentials(lower(student_email))whererevoked_atisnull",
			"audit_log_created_at_id_idx":                "audit_log(created_at,id)",
		}[name]
		compact := strings.ToLower(strings.Join(strings.Fields(statement), ""))
		compact = strings.NewReplacer("\"", "", "`", "", "[", "", "]", "").Replace(compact)
		if !strings.HasSuffix(strings.TrimSuffix(compact, ";"), "on"+expected) {
			return fmt.Errorf("required index definition is invalid: %s", name)
		}
		if strings.HasPrefix(name, "guest_credentials_active_") && !strings.Contains(normalized, "where revoked_at is null") {
			return errors.New("current-credential partial index predicate is invalid")
		}
	}
	r, e = d.QueryContext(ctx, "SELECT name,tailscale_ip,ssh_host_key_sha256,webhook_token FROM machines")
	if e != nil {
		return e
	}
	defer r.Close()
	names, ips, pins, tokens := map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}
	for r.Next() {
		var name, ip, token string
		var pin sql.NullString
		if e = r.Scan(&name, &ip, &pin, &token); e != nil {
			return e
		}
		a, err := netip.ParseAddr(ip)
		if err != nil || !a.Is4() || a.String() != ip || !netip.MustParsePrefix("100.64.0.0/10").Contains(a) || !regexp.MustCompile(`^[A-Za-z0-9._ -]{1,64}$`).MatchString(name) || !config.ValidBearer(token) {
			return errors.New("non-canonical machine identity or token")
		}
		if names[name] || ips[ip] || tokens[token] {
			return errors.New("duplicate machine identity")
		}
		names[name] = true
		ips[ip] = true
		tokens[token] = true
		if pin.Valid {
			b, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(pin.String, "SHA256:"))
			if err != nil || len(b) != 32 || "SHA256:"+base64.RawStdEncoding.EncodeToString(b) != pin.String || pins[pin.String] {
				return errors.New("invalid or duplicate SSH host-key pin")
			}
			pins[pin.String] = true
		}
	}
	return r.Err()
}
func (s *Store) Tx(ctx context.Context, f func(*sql.Tx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer t.Rollback()
	if e = f(t); e != nil {
		return e
	}
	return t.Commit()
}
func ID() string             { return Random(24) }
func Time(t time.Time) int64 { return t.UTC().UnixMilli() }
func ISO(v sql.NullInt64) *string {
	if !v.Valid {
		return nil
	}
	s := time.UnixMilli(v.Int64).UTC().Format("2006-01-02T15:04:05.000Z")
	return &s
}
func Str(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	return &v.String
}
func Unique(e error) bool { return e != nil && strings.Contains(e.Error(), "UNIQUE constraint failed") }
