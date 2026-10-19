// Package migration is linked only by labgate-migrate, never by the application.
package migration

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"labgate/internal/store"
	_ "modernc.org/sqlite"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const schema = `
CREATE TABLE IF NOT EXISTS machines(id TEXT PRIMARY KEY,name TEXT NOT NULL,tailscale_ip TEXT NOT NULL,webhook_token TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offline',last_heartbeat INTEGER,ssh_host_key_sha256 TEXT,safety_hold_credential_id TEXT,is_hidden BOOLEAN NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS guest_credentials(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL REFERENCES machines(id) ON UPDATE CASCADE ON DELETE RESTRICT,student_email TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,session_opened_at INTEGER,machine_state_version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY,machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL,student_email TEXT,event TEXT NOT NULL,detail TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,emailVerified BOOLEAN NOT NULL DEFAULT 1,image TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS go_sessions(token_hash TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,expires_at INTEGER NOT NULL,kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS go_pairings(id TEXT PRIMARY KEY,secret_hash TEXT NOT NULL,code TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL,email TEXT,name TEXT,approved_at INTEGER);
CREATE TABLE IF NOT EXISTS go_oauth(state_hash TEXT PRIMARY KEY,nonce TEXT NOT NULL,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS labgate_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS machines_name_key ON machines(name);
CREATE UNIQUE INDEX IF NOT EXISTS machines_tailscale_ip_key ON machines(tailscale_ip);
CREATE UNIQUE INDEX IF NOT EXISTS machines_webhook_token_key ON machines(webhook_token);
CREATE UNIQUE INDEX IF NOT EXISTS machines_ssh_host_key_sha256_key ON machines(ssh_host_key_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS guest_credentials_active_machine_key ON guest_credentials(machine_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS guest_credentials_active_student_email_key ON guest_credentials(LOWER(student_email)) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS audit_log_created_at_id_idx ON audit_log(created_at,id);
`

type Options struct {
	Path   string
	DryRun bool
}

func Run(o Options) (string, error) {
	if o.Path == "" {
		return "", errors.New("database path is required")
	}
	abs, e := filepath.Abs(o.Path)
	if e != nil {
		return "", e
	}
	info, se := os.Lstat(abs)
	if se == nil && !info.Mode().IsRegular() {
		return "", errors.New("database must be a regular file, not a symlink")
	}
	fresh := os.IsNotExist(se)
	if se != nil && !fresh {
		return "", se
	}
	if o.DryRun {
		dir, err := os.MkdirTemp("", "labgate-migration-preflight-")
		if err != nil {
			return "", err
		}
		defer os.RemoveAll(dir)
		copyPath := filepath.Join(dir, "preflight.db")
		if !fresh {
			d, err := sql.Open("sqlite", "file:"+url.PathEscape(abs)+"?mode=ro")
			if err != nil {
				return "", err
			}
			_, err = d.Exec("VACUUM INTO ?", copyPath)
			d.Close()
			if err != nil {
				return "", fmt.Errorf("preflight snapshot failed: %w", err)
			}
		}
		if _, err := Run(Options{Path: copyPath}); err != nil {
			return "", fmt.Errorf("migration preflight failed: %w", err)
		}
		if fresh {
			return "Would initialize a fresh database. Schema and postflight validated on a disposable copy. No source files changed.", nil
		}
		return "Would back up and upgrade the existing SQLite database. Transaction and postflight validated on a disposable snapshot. Stop all writers before applying. No source files changed.", nil
	}

	if e = os.MkdirAll(filepath.Dir(abs), 0700); e != nil {
		return "", e
	}
	l, e := os.OpenFile(abs+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return "", e
	}
	defer l.Close()
	if e = unix.Flock(int(l.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		return "", errors.New("stop LabGate before migrating; database is in use")
	}
	d, e := sql.Open("sqlite", "file:"+url.PathEscape(abs)+"?mode=rwc&_pragma=foreign_keys(1)&_pragma=busy_timeout(1000)")
	if e != nil {
		return "", e
	}
	defer d.Close()
	d.SetMaxOpenConns(1)
	var installed int
	if err := d.QueryRow("SELECT version FROM labgate_schema WHERE id=1").Scan(&installed); err == nil {
		if installed > store.Version {
			return "", errors.New("database schema is newer than this release")
		}
		if installed == store.Version {
			if err = store.ValidateDomain(d); err != nil {
				return "", err
			}
			return "Database already current; no changes made.", nil
		}
	}
	backup := ""
	if !fresh {
		backup = abs + ".backup-" + time.Now().UTC().Format("20060102T150405.000000000")
		if _, e = d.Exec("VACUUM INTO ?", backup); e != nil {
			return "", fmt.Errorf("backup failed: %w", e)
		}
		if e = os.Chmod(backup, 0600); e != nil {
			return "", e
		}
	}
	t, e := d.BeginTx(context.Background(), nil)
	if e != nil {
		return "", e
	}
	defer t.Rollback()
	// Extend legacy tables before installing indexes. All changes roll back together.
	additions := map[string]map[string]string{"machines": {"ssh_host_key_sha256": "TEXT", "safety_hold_credential_id": "TEXT", "is_hidden": "BOOLEAN NOT NULL DEFAULT 0"}, "guest_credentials": {"session_opened_at": "INTEGER", "machine_state_version": "INTEGER NOT NULL DEFAULT 0"}}
	for table, cols := range additions {
		rows, e := t.Query("PRAGMA table_info(" + table + ")")
		if e != nil {
			return "", e
		}
		known := map[string]bool{}
		for rows.Next() {
			var cid, nn, pk int
			var name, typ string
			var def any
			if e = rows.Scan(&cid, &name, &typ, &nn, &def, &pk); e != nil {
				rows.Close()
				return "", e
			}
			known[name] = true
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return "", e
		}
		if len(known) > 0 {
			for col, typ := range cols {
				if !known[col] {
					if _, e = t.Exec("ALTER TABLE " + table + " ADD COLUMN " + col + " " + typ); e != nil {
						return "", e
					}
				}
			}
		}
	}
	if _, e = t.Exec(schema); e != nil {
		return "", e
	}
	for table, cols := range map[string][]string{"machines": {"last_heartbeat"}, "guest_credentials": {"created_at", "expires_at", "revoked_at", "session_opened_at"}, "audit_log": {"created_at"}} {
		for _, col := range cols {
			if e = normalize(t, table, col); e != nil {
				return "", e
			}
		}
	}
	if _, e = t.Exec("UPDATE guest_credentials SET machine_state_version=3 WHERE revoked_at IS NOT NULL"); e != nil {
		return "", e
	}
	// Re-login is explicit; preserve historical users/accounts and all domain data.
	var sessionExists int
	t.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session'").Scan(&sessionExists)
	if sessionExists > 0 {
		if _, e = t.Exec(`DELETE FROM session`); e != nil {
			return "", e
		}
	}
	if _, e = t.Exec("DELETE FROM go_sessions; DELETE FROM go_pairings; DELETE FROM go_oauth; INSERT INTO labgate_schema(id,version) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version", store.Version); e != nil {
		return "", e
	}
	// Validate unsafe drift inside the migration transaction, before commit.
	for _, q := range []string{`SELECT COUNT(*) FROM machines m WHERE status='available' AND (safety_hold_credential_id IS NOT NULL OR EXISTS(SELECT 1 FROM guest_credentials c WHERE c.machine_id=m.id AND c.revoked_at IS NULL))`, `SELECT COUNT(*) FROM machines WHERE status NOT IN ('available','occupied','offline')`} {
		var n int
		if e = t.QueryRow(q).Scan(&n); e != nil || n != 0 {
			return "", errors.New("unsafe domain state; migration rolled back, reconcile the legacy database")
		}
	}
	if e = store.ValidateQuery(context.Background(), t); e != nil {
		return "", e
	}
	if e = t.Commit(); e != nil {
		return "", e
	}
	if e = os.Chmod(abs, 0600); e != nil {
		return "", e
	}
	if e = store.ValidateDomain(d); e != nil {
		return "", e
	}
	if fresh {
		return "Database initialized. Setup/startup did not perform this operation.", nil
	}
	return "Migration complete; users must sign in again. Backup: " + backup, nil
}
func normalize(t *sql.Tx, table, col string) error {
	r, e := t.Query("SELECT id,CAST(" + col + " AS TEXT) FROM " + table + " WHERE " + col + " IS NOT NULL")
	if e != nil {
		return e
	}
	type update struct {
		id string
		ms int64
	}
	var updates []update
	for r.Next() {
		var id, v string
		if e = r.Scan(&id, &v); e != nil {
			r.Close()
			return e
		}
		ms, e := ParseTime(v)
		if e != nil {
			r.Close()
			return fmt.Errorf("invalid %s.%s timestamp for row %s", table, col, id)
		}
		updates = append(updates, update{id, ms})
	}
	e = r.Err()
	r.Close()
	if e != nil {
		return e
	}
	for _, u := range updates {
		if _, e = t.Exec("UPDATE "+table+" SET "+col+"=? WHERE id=?", u.ms, u.id); e != nil {
			return e
		}
	}
	return nil
}
func ParseTime(v string) (int64, error) {
	if n, e := strconv.ParseInt(v, 10, 64); e == nil {
		return n, nil
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999-07:00", "2006-01-02 15:04:05.999999999", "2006-01-02T15:04:05.999999999"} {
		if t, e := time.Parse(layout, v); e == nil {
			return t.UnixMilli(), nil
		}
	}
	return 0, errors.New("invalid timestamp")
}
