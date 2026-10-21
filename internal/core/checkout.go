package core

import (
	"context"
	"database/sql"
	"errors"
	"labgate/internal/store"
	"time"
)

type Issued struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Expires  string `json:"expiresAt"`
}

func (s *Service) Checkout(ctx context.Context, mid, email string) (Issued, error) {
	if !s.Config.Allowed(email) {
		return Issued{}, fail(403, "University account required")
	}
	email = lower(email)
	now := store.Time(s.Now())
	expires := now + s.Config.TTL().Milliseconds()
	password, e := Password(s.Config.PasswordLength)
	if e != nil {
		return Issued{}, e
	}
	id := store.ID()
	var m Machine
	e = s.Store.Tx(ctx, func(t *sql.Tx) error {
		var n int
		if e := t.QueryRowContext(ctx, "SELECT COUNT(*) FROM guest_credentials WHERE LOWER(student_email)=? AND revoked_at IS NULL", email).Scan(&n); e != nil {
			return e
		}
		if n > 0 {
			return fail(409, "You already have a reservation or active session")
		}
		r, e := t.ExecContext(ctx, "UPDATE machines SET status='occupied' WHERE id=? AND status='available' AND is_hidden=0 AND ssh_host_key_sha256 IS NOT NULL AND safety_hold_credential_id IS NULL AND last_heartbeat BETWEEN ? AND ?", mid, now-120000, now+30000)
		if e != nil {
			return e
		}
		nrows, _ := r.RowsAffected()
		if nrows != 1 {
			return fail(409, "Machine is no longer available")
		}
		m, e = machine(ctx, t, mid)
		if e != nil {
			return e
		}
		if _, e = t.ExecContext(ctx, "INSERT INTO guest_credentials(id,machine_id,student_email,created_at,expires_at,machine_state_version) VALUES(?,?,?,?,?,0)", id, mid, email, now, expires); e != nil {
			return e
		}
		return Audit(ctx, t, mid, email, "checkout", "", now)
	})
	if store.Unique(e) {
		e = fail(409, "Reservation conflict")
	}
	if e != nil {
		return Issued{}, e
	}
	if e = s.Provision.Issue(ctx, m, id, expires/1000, password); e != nil {
		return Issued{}, s.compensate(m, id, email)
	}
	e = s.Store.Tx(ctx, func(t *sql.Tx) error {
		r, e := t.ExecContext(ctx, "UPDATE machines SET status='occupied' WHERE id=? AND tailscale_ip=? AND ssh_host_key_sha256=? AND status='occupied' AND safety_hold_credential_id IS NULL", m.ID, m.IP, *m.Pin)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n != 1 {
			return errors.New("reservation lost")
		}
		r, e = t.ExecContext(ctx, "UPDATE guest_credentials SET machine_state_version=1 WHERE id=? AND machine_id=? AND revoked_at IS NULL AND session_opened_at IS NULL AND machine_state_version<=1", id, mid)
		if e != nil {
			return e
		}
		n, _ = r.RowsAffected()
		if n != 1 {
			return errors.New("pending generation lost")
		}
		return Audit(ctx, t, mid, email, "provision_ok", "", store.Time(s.Now()))
	})
	if e != nil {
		return Issued{}, s.compensate(m, id, email)
	}
	return Issued{"guest", password, stamp(expires)}, nil
}
func (s *Service) compensate(target Machine, id, email string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	now := store.Time(s.Now())
	prep := s.Store.Tx(ctx, func(t *sql.Tx) error {
		m, e := machine(ctx, t, target.ID)
		if e != nil {
			return e
		}
		if m.IP != target.IP || !same(m.Pin, target.Pin) {
			return nil
		}
		ids, e := current(ctx, t, m.ID)
		if e != nil {
			return e
		}
		for _, v := range ids {
			if v != id {
				m.Hold = merge(m.Hold, v)
			}
		}
		m.Hold = merge(m.Hold, id)
		if len(ids) == 0 || len(ids) == 1 && ids[0] == id {
			if _, e = t.ExecContext(ctx, "UPDATE guest_credentials SET revoked_at=NULL,expires_at=?,machine_state_version=CASE WHEN session_opened_at IS NULL THEN 1 ELSE 2 END WHERE id=?", now, id); e != nil {
				return e
			}
		}
		_, e = t.ExecContext(ctx, "UPDATE machines SET status='occupied',safety_hold_credential_id=? WHERE id=?", m.Hold, m.ID)
		return e
	})
	if prep != nil {
		return fail(503, "Provisioning failed; reconciliation required")
	}
	locked := s.Provision.Revoke(ctx, target, id) == nil
	e := s.Store.Tx(ctx, func(t *sql.Tx) error {
		m, e := machine(ctx, t, target.ID)
		if e != nil {
			return e
		}
		if m.IP != target.IP || !same(m.Pin, target.Pin) {
			return nil
		}
		if locked {
			if _, e = t.ExecContext(ctx, "UPDATE guest_credentials SET revoked_at=?,machine_state_version=3 WHERE id=?", now, id); e != nil {
				return e
			}
			ids, e := current(ctx, t, m.ID)
			if e != nil {
				return e
			}
			if len(ids) == 0 && (m.Hold == nil || *m.Hold == id) {
				if _, e = t.ExecContext(ctx, "UPDATE machines SET status='available',safety_hold_credential_id=NULL WHERE id=?", m.ID); e != nil {
					return e
				}
			}
		}
		return Audit(ctx, t, m.ID, email, "provision_fail", "Provisioning failed; exact-generation compensation attempted.", now)
	})
	if e != nil {
		return fail(503, "Provisioning failed; reconciliation required")
	}
	return fail(502, "Machine provisioning failed; no password was issued")
}

type Expiry struct {
	Status   string `json:"status"`
	Released bool   `json:"releasedMachine"`
}

func (s *Service) Expire(ctx context.Context, id string) (Expiry, error) {
	c, e := credential(ctx, s.Store.DB, id)
	if e == sql.ErrNoRows || e == nil && c.Revoked.Valid {
		return Expiry{"already_released", false}, nil
	}
	if e != nil {
		return Expiry{}, e
	}
	now := store.Time(s.Now())
	if c.Opened.Valid {
		return Expiry{"active", false}, nil
	}
	if c.Expires > now {
		return Expiry{"retry", false}, nil
	}
	m, e := machine(ctx, s.Store.DB, c.MachineID)
	if e != nil {
		return Expiry{}, e
	}
	if m.Pin == nil || s.Provision.Revoke(ctx, m, id) != nil {
		return Expiry{"retry", false}, nil
	}
	result := Expiry{"already_released", false}
	e = s.Store.Tx(ctx, func(t *sql.Tx) error {
		latest, e := credential(ctx, t, id)
		if e != nil {
			return e
		}
		if latest.Opened.Valid && !latest.Revoked.Valid {
			result.Status = "active"
			return nil
		}
		if latest.Revoked.Valid || latest.Expires > now {
			return nil
		}
		currentMachine, e := machine(ctx, t, m.ID)
		if e != nil {
			return e
		}
		if currentMachine.IP != m.IP || !same(currentMachine.Pin, m.Pin) {
			result.Status = "retry"
			return nil
		}
		if _, e = t.ExecContext(ctx, "UPDATE guest_credentials SET revoked_at=?,machine_state_version=3 WHERE id=? AND revoked_at IS NULL AND session_opened_at IS NULL", now, id); e != nil {
			return e
		}
		result.Status = "held"
		ids, e := current(ctx, t, m.ID)
		if e != nil {
			return e
		}
		if len(ids) == 0 && (currentMachine.Hold == nil || *currentMachine.Hold == id) {
			if _, e = t.ExecContext(ctx, "UPDATE machines SET status='available',safety_hold_credential_id=NULL WHERE id=?", m.ID); e != nil {
				return e
			}
			result = Expiry{"released", true}
		}
		if e = Audit(ctx, t, m.ID, c.Email, "force_revoke", "Expired generation locked over SSH.", now); e != nil {
			return e
		}
		return Audit(ctx, t, m.ID, c.Email, "password_timeout", "Password timed out before physical login.", now)
	})
	return result, e
}

type SweepResult struct {
	Revoked  int `json:"revokedCredentials"`
	Released int `json:"releasedMachines"`
	Pending  int `json:"pendingCredentials"`
	Deferred int `json:"deferredCredentials"`
	Active   int `json:"activeCredentials"`
}

func (s *Service) Sweep(ctx context.Context) (SweepResult, error) {
	s.sweep.Lock()
	defer s.sweep.Unlock()
	now := store.Time(s.Now())
	out := SweepResult{}
	var count int
	if e := s.Store.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM guest_credentials WHERE revoked_at IS NULL AND session_opened_at IS NULL AND expires_at<=?", now).Scan(&count); e != nil {
		return out, e
	}
	if e := s.Store.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM guest_credentials WHERE revoked_at IS NULL AND session_opened_at IS NOT NULL AND expires_at<=?", now).Scan(&out.Active); e != nil {
		return out, e
	}
	r, e := s.Store.DB.QueryContext(ctx, "SELECT id FROM guest_credentials WHERE revoked_at IS NULL AND session_opened_at IS NULL AND expires_at<=? ORDER BY expires_at,id LIMIT 4", now)
	if e != nil {
		return out, e
	}
	var ids []string
	for r.Next() {
		var id string
		if e = r.Scan(&id); e != nil {
			r.Close()
			return out, e
		}
		ids = append(ids, id)
	}
	e = r.Err()
	r.Close()
	if e != nil {
		return out, e
	}
	out.Deferred = count - len(ids)
	for _, id := range ids {
		v, e := s.Expire(ctx, id)
		if e != nil {
			return out, e
		}
		if v.Status == "held" || v.Status == "released" {
			out.Revoked++
		}
		if v.Released {
			out.Released++
		}
		if v.Status == "retry" {
			out.Pending++
		}
	}
	return out, nil
}
