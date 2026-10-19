package core

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"labgate/internal/store"
	"strings"
)

func lower(v string) string { return strings.ToLower(v) }

type Report struct {
	ID      *string `json:"credentialId"`
	Version *int    `json:"stateVersion"`
	Locked  *bool   `json:"guestLocked"`
	Active  *bool   `json:"sessionActive"`
	State   *string `json:"state"`
}

func (r Report) Valid(heartbeat bool, endpoint string) bool {
	if r.ID != nil && !CredentialID.MatchString(*r.ID) {
		return false
	}
	if !heartbeat {
		if r.ID == nil || r.Version == nil {
			return false
		}
		if endpoint == "session-open" {
			return *r.Version == 2
		}
		return *r.Version == 3
	}
	if r.Locked == nil || r.Active == nil {
		return false
	}
	if r.ID == nil {
		return r.State == nil && r.Version == nil && !*r.Active
	}
	if r.State == nil || r.Version == nil {
		return false
	}
	switch *r.State {
	case "pending":
		return *r.Version == 1 && !*r.Active && !*r.Locked
	case "active":
		return *r.Version == 2 && *r.Active && !*r.Locked
	case "revoked":
		return *r.Version == 3 && !*r.Active && *r.Locked
	}
	return false
}
func (s *Service) Webhook(ctx context.Context, token, endpoint string, r Report) (string, error) {
	if !r.Valid(endpoint == "heartbeat", endpoint) {
		return "", fail(400, "Invalid machine report or endpoint version")
	}
	status := "observed"
	e := s.Store.Tx(ctx, func(t *sql.Tx) error {
		m, e := machineScan(t.QueryRowContext(ctx, "SELECT "+machineCols+" FROM machines WHERE webhook_token=?", token))
		if e == sql.ErrNoRows {
			return fail(401, "Unauthorized")
		}
		if e != nil {
			return e
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(m.Token)) != 1 {
			return fail(401, "Unauthorized")
		}
		now := store.Time(s.Now())
		if endpoint == "heartbeat" && r.ID == nil {
			ids, e := current(ctx, t, m.ID)
			if e != nil {
				return e
			}
			state := "occupied"
			hold := m.Hold
			if *r.Locked && len(ids) == 0 {
				state = "available"
				hold = nil
			} else if !*r.Locked {
				if _, e = t.ExecContext(ctx, "UPDATE guest_credentials SET revoked_at=?,machine_state_version=3 WHERE machine_id=? AND revoked_at IS NULL", now, m.ID); e != nil {
					return e
				}
				hold = merge(hold, ConflictHold)
			}
			if m.Pin == nil && state == "available" {
				state = "offline"
			}
			_, e = t.ExecContext(ctx, "UPDATE machines SET last_heartbeat=?,status=?,safety_hold_credential_id=? WHERE id=?", now, state, hold, m.ID)
			return e
		}
		id := *r.ID
		c, ce := credential(ctx, t, id)
		exists := ce == nil && c.MachineID == m.ID
		if ce != nil && ce != sql.ErrNoRows {
			return ce
		}
		heartbeat := endpoint == "heartbeat"
		opening := endpoint == "session-open" || heartbeat && r.State != nil && *r.State == "active"
		pending := heartbeat && r.State != nil && *r.State == "pending"
		if opening || pending {
			valid := exists && !c.Revoked.Valid && ((pending && c.Version < 2) || (opening && c.Version <= 2))
			if !valid {
				return unsafe(ctx, t, m, id, now, &status, pending, exists)
			}
			if pending {
				if _, e = t.ExecContext(ctx, "UPDATE guest_credentials SET machine_state_version=1 WHERE id=? AND machine_state_version<1", id); e != nil {
					return e
				}
				status = "observed"
			} else if c.Version < 2 {
				if _, e = t.ExecContext(ctx, "UPDATE guest_credentials SET machine_state_version=2,session_opened_at=COALESCE(session_opened_at,?),revoked_at=NULL WHERE id=?", now, id); e != nil {
					return e
				}
				status = "activated"
				if e = Audit(ctx, t, m.ID, c.Email, "session_open", "Physical guest session confirmed.", now); e != nil {
					return e
				}
			} else {
				status = "already_active"
			}
			hold := m.Hold
			if heartbeat {
				hold = reconcile(hold, id)
			} else if status == "activated" {
				hold = merge(hold, id)
			}
			_, e = t.ExecContext(ctx, "UPDATE machines SET status='occupied',last_heartbeat=?,safety_hold_credential_id=? WHERE id=?", now, hold, m.ID)
			return e
		}
		event := "session_close"
		timeout := endpoint == "credential-expired"
		if timeout || heartbeat && r.State != nil && *r.State == "revoked" {
			event = "force_revoke"
		}
		changed := exists && c.Version < 3
		if changed {
			if _, e = t.ExecContext(ctx, "UPDATE guest_credentials SET revoked_at=?,machine_state_version=3 WHERE id=?", now, id); e != nil {
				return e
			}
		}
		ids, e := current(ctx, t, m.ID)
		if e != nil {
			return e
		}
		hold := m.Hold
		exact := hold != nil && *hold == id
		if exact || heartbeat && len(ids) == 0 {
			hold = nil
		}
		state := m.Status
		if changed || exact || heartbeat {
			state = "occupied"
			if len(ids) == 0 && hold == nil {
				state = "available"
				if m.Pin == nil {
					state = "offline"
				}
			}
		}
		if _, e = t.ExecContext(ctx, "UPDATE machines SET status=?,last_heartbeat=?,safety_hold_credential_id=? WHERE id=?", state, now, hold, m.ID); e != nil {
			return e
		}
		if changed || !exists {
			email := ""
			if exists {
				email = c.Email
			}
			if e = Audit(ctx, t, m.ID, email, event, "Terminal generation report acknowledged.", now); e != nil {
				return e
			}
			if timeout && changed && !c.Opened.Valid {
				if e = Audit(ctx, t, m.ID, email, "password_timeout", "Password timed out before physical login.", now); e != nil {
					return e
				}
			}
		}
		if changed || exact || heartbeat && len(ids) == 0 {
			status = "closed"
		} else if exists {
			status = "already_closed"
		} else {
			status = "not_found"
		}
		return nil
	})
	return status, e
}
func unsafe(ctx context.Context, t *sql.Tx, m Machine, id string, now int64, status *string, pending, exists bool) error {
	ids, e := current(ctx, t, m.ID)
	if e != nil {
		return e
	}
	hold := m.Hold
	for _, v := range ids {
		hold = merge(hold, v)
	}
	hold = merge(hold, id)
	if _, e = t.ExecContext(ctx, "UPDATE guest_credentials SET revoked_at=?,machine_state_version=3 WHERE machine_id=? AND revoked_at IS NULL", now, m.ID); e != nil {
		return e
	}
	if _, e = t.ExecContext(ctx, "UPDATE machines SET status='occupied',last_heartbeat=?,safety_hold_credential_id=? WHERE id=?", now, hold, m.ID); e != nil {
		return e
	}
	*status = "not_found"
	if exists {
		*status = "stale"
	}
	if pending {
		*status = "unsafe_pending"
	}
	return Audit(ctx, t, m.ID, "", "session_open", "Unsafe physical generation held for reconciliation.", now)
}
