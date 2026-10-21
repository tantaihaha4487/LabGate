package core

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"labgate/internal/config"
	"labgate/internal/store"
	"math/big"
	"net/netip"
	"regexp"
	"strings"
	"sync"
	"time"
)

const ConflictHold = "!conflicting-physical-generations!"

var CredentialID = regexp.MustCompile(`^[A-Za-z0-9_-]{20,64}$`)
var namePattern = regexp.MustCompile(`^[A-Za-z0-9._ -]{1,64}$`)

type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string          { return e.Message }
func fail(status int, msg string) error { return &Error{status, msg} }

type Service struct {
	Store     *store.Store
	Config    config.Config
	Provision Provisioner
	Now       func() time.Time
	sweep     sync.Mutex
}

func New(s *store.Store, c config.Config, p Provisioner) *Service {
	return &Service{Store: s, Config: c, Provision: p, Now: time.Now}
}

type Reservation struct {
	ID      string  `json:"id"`
	Email   string  `json:"studentEmail"`
	State   string  `json:"state"`
	Created string  `json:"createdAt"`
	Expires string  `json:"expiresAt"`
	Revoked *string `json:"revokedAt"`
	Opened  *string `json:"sessionOpenedAt"`
	Version int     `json:"machineStateVersion"`
}
type Machine struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	IP           string       `json:"tailscaleIp"`
	Pin          *string      `json:"sshHostKeySha256"`
	Token        string       `json:"-"`
	Status       string       `json:"status"`
	Hidden       bool         `json:"isHidden"`
	Heartbeat    *string      `json:"lastHeartbeat"`
	Hold         *string      `json:"safetyHoldCredentialId"`
	Connectivity string       `json:"connectivity"`
	Reservation  *Reservation `json:"currentReservation"`
	Last         int64        `json:"-"`
}
type Credential struct {
	ID, MachineID, Email string
	Created, Expires     int64
	Revoked, Opened      sql.NullInt64
	Version              int
}

const machineCols = "id,name,tailscale_ip,ssh_host_key_sha256,webhook_token,status,is_hidden,last_heartbeat,safety_hold_credential_id"

func machineScan(row interface{ Scan(...any) error }) (Machine, error) {
	var m Machine
	var pin, hold sql.NullString
	var hb sql.NullInt64
	e := row.Scan(&m.ID, &m.Name, &m.IP, &pin, &m.Token, &m.Status, &m.Hidden, &hb, &hold)
	m.Pin = store.Str(pin)
	m.Hold = store.Str(hold)
	m.Heartbeat = store.ISO(hb)
	m.Last = hb.Int64
	return m, e
}
func machine(ctx context.Context, q store.Querier, id string) (Machine, error) {
	return machineScan(q.QueryRowContext(ctx, "SELECT "+machineCols+" FROM machines WHERE id=?", id))
}
func credential(ctx context.Context, q store.Querier, id string) (Credential, error) {
	var c Credential
	e := q.QueryRowContext(ctx, "SELECT id,machine_id,student_email,created_at,expires_at,revoked_at,session_opened_at,machine_state_version FROM guest_credentials WHERE id=?", id).Scan(&c.ID, &c.MachineID, &c.Email, &c.Created, &c.Expires, &c.Revoked, &c.Opened, &c.Version)
	return c, e
}
func stamp(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }
func (s *Service) List(ctx context.Context, admin bool) ([]Machine, error) {
	rows, e := s.Store.DB.QueryContext(ctx, "SELECT "+machineCols+" FROM machines ORDER BY name")
	if e != nil {
		return nil, e
	}
	out := []Machine{}
	for rows.Next() {
		m, e := machineScan(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		if !admin && m.Hidden {
			continue
		}
		now := store.Time(s.Now())
		m.Connectivity = "offline"
		if m.Last >= now-120000 && m.Last <= now+30000 {
			m.Connectivity = "online"
		}
		out = append(out, m)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	for i := range out {
		m := &out[i]
		if admin {
			var c Credential
			c.MachineID = m.ID
			e = s.Store.DB.QueryRowContext(ctx, "SELECT id,student_email,created_at,expires_at,session_opened_at,machine_state_version FROM guest_credentials WHERE machine_id=? AND revoked_at IS NULL", m.ID).Scan(&c.ID, &c.Email, &c.Created, &c.Expires, &c.Opened, &c.Version)
			if e == nil {
				state := "pending"
				if c.Opened.Valid {
					state = "active"
				}
				m.Reservation = &Reservation{ID: c.ID, Email: c.Email, State: state, Created: stamp(c.Created), Expires: stamp(c.Expires), Opened: store.ISO(c.Opened), Version: c.Version}
			} else if e != sql.ErrNoRows {
				return nil, e
			}
		} else {
			if m.Status != "available" || m.Pin == nil {
				m.Status = "occupied"
			}
			m.IP = ""
			m.Pin = nil
			m.Hold = nil
		}
	}
	return out, nil
}
func Audit(ctx context.Context, q store.Querier, mid, email, event, detail string, now int64) error {
	var m, e any
	if mid != "" {
		m = mid
	}
	if email != "" {
		e = email
	}
	if len(detail) > 500 {
		detail = detail[:500]
	}
	_, err := q.ExecContext(ctx, "INSERT INTO audit_log(id,machine_id,student_email,event,detail,created_at) VALUES(?,?,?,?,?,?)", store.ID(), m, e, event, detail, now)
	return err
}
func Password(n int) (string, error) {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
	b := make([]byte, n)
	for i := range b {
		v, e := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		if e != nil {
			return "", e
		}
		b[i] = chars[v.Int64()]
	}
	return string(b), nil
}
func ValidPin(p string) bool {
	if !strings.HasPrefix(p, "SHA256:") {
		return false
	}
	v, e := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(p, "SHA256:"))
	return e == nil && len(v) == 32 && "SHA256:"+base64.RawStdEncoding.EncodeToString(v) == p
}
func ValidIP(p string) bool {
	a, e := netip.ParseAddr(p)
	return e == nil && a.Is4() && a.String() == p && netip.MustParsePrefix("100.64.0.0/10").Contains(a)
}
func ptr(v string) *string { return &v }
func merge(hold *string, id string) *string {
	if hold == nil || *hold == id {
		return ptr(id)
	}
	return ptr(ConflictHold)
}
func reconcile(hold *string, id string) *string {
	if hold == nil || *hold == id {
		return nil
	}
	return ptr(ConflictHold)
}
func current(ctx context.Context, q store.Querier, mid string) ([]string, error) {
	r, e := q.QueryContext(ctx, "SELECT id FROM guest_credentials WHERE machine_id=? AND revoked_at IS NULL", mid)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	var ids []string
	for r.Next() {
		var id string
		if e = r.Scan(&id); e != nil {
			return nil, e
		}
		ids = append(ids, id)
	}
	return ids, r.Err()
}
func (s *Service) Visibility(ctx context.Context, id string, hidden bool, email string) (string, error) {
	status := "unchanged"
	e := s.Store.Tx(ctx, func(t *sql.Tx) error {
		m, e := machine(ctx, t, id)
		if e == sql.ErrNoRows {
			return fail(404, "Machine not found")
		}
		if e != nil {
			return e
		}
		if m.Hidden == hidden {
			return nil
		}
		if _, e = t.ExecContext(ctx, "UPDATE machines SET is_hidden=? WHERE id=?", hidden, id); e != nil {
			return e
		}
		event := "machine_restore"
		if hidden {
			event = "machine_hide"
		}
		status = "updated"
		return Audit(ctx, t, id, email, event, "Visibility changed; lifecycle state preserved.", store.Time(s.Now()))
	})
	return status, e
}

type Identity struct {
	Name         string  `json:"name"`
	IP           string  `json:"tailscaleIp"`
	Pin          string  `json:"sshHostKeySha256"`
	MachineID    string  `json:"machineId"`
	ExpectedName string  `json:"expectedName"`
	ExpectedIP   string  `json:"expectedTailscaleIp"`
	ExpectedPin  *string `json:"expectedSshHostKeySha256"`
}

func (s *Service) Enroll(ctx context.Context, v Identity, rekey bool, email string) (map[string]any, error) {
	if !namePattern.MatchString(v.Name) || !ValidIP(v.IP) || !ValidPin(v.Pin) {
		return nil, fail(400, "Valid name, canonical Tailscale IPv4 and Ed25519 SHA256 pin required")
	}
	out := map[string]any{}
	e := s.Store.Tx(ctx, func(t *sql.Tx) error {
		if rekey {
			if !CredentialID.MatchString(v.MachineID) || !namePattern.MatchString(v.ExpectedName) || !ValidIP(v.ExpectedIP) || v.ExpectedPin != nil && !ValidPin(*v.ExpectedPin) {
				return fail(400, "Exact expected machine identity required")
			}
			m, e := machine(ctx, t, v.MachineID)
			if e == sql.ErrNoRows {
				return fail(404, "Machine not found")
			}
			if e != nil {
				return e
			}
			if m.Name != v.ExpectedName || m.IP != v.ExpectedIP || !same(m.Pin, v.ExpectedPin) {
				return fail(409, "Machine identity changed")
			}
			ids, e := current(ctx, t, m.ID)
			if e != nil {
				return e
			}
			if m.Status != "available" || m.Hold != nil || len(ids) > 0 {
				return fail(409, "Rekey requires an available drained machine without a safety hold")
			}
			token := store.Random(32)
			_, e = t.ExecContext(ctx, "UPDATE machines SET name=?,tailscale_ip=?,ssh_host_key_sha256=?,webhook_token=?,last_heartbeat=NULL,status='offline' WHERE id=?", v.Name, v.IP, v.Pin, token, m.ID)
			if e != nil {
				return e
			}
			out = map[string]any{"webhookToken": token, "machineId": m.ID}
			return Audit(ctx, t, m.ID, email, "machine_rekey", "Identity replaced; awaiting safe heartbeat.", store.Time(s.Now()))
		}
		r, e := t.QueryContext(ctx, "SELECT "+machineCols+" FROM machines WHERE name=? OR tailscale_ip=? OR ssh_host_key_sha256=?", v.Name, v.IP, v.Pin)
		if e != nil {
			return e
		}
		var matches []Machine
		for r.Next() {
			m, e := machineScan(r)
			if e != nil {
				r.Close()
				return e
			}
			matches = append(matches, m)
		}
		e = r.Err()
		r.Close()
		if e != nil {
			return e
		}
		if len(matches) > 0 {
			m := matches[0]
			if len(matches) != 1 || m.Name != v.Name || m.IP != v.IP || m.Pin == nil || *m.Pin != v.Pin {
				return fail(409, "Machine identity conflict; use drained rekey")
			}
			out["webhookToken"] = m.Token
			return nil
		}
		id, token := store.ID(), store.Random(32)
		_, e = t.ExecContext(ctx, "INSERT INTO machines(id,name,tailscale_ip,ssh_host_key_sha256,webhook_token,status,is_hidden) VALUES(?,?,?,?,?,'offline',0)", id, v.Name, v.IP, v.Pin, token)
		out["webhookToken"] = token
		return e
	})
	if store.Unique(e) {
		e = fail(409, "Machine identity conflict")
	}
	return out, e
}
func same(a, b *string) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
