package core

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"time"
)

type Activity struct {
	ID       string `json:"id"`
	Source   string `json:"source"`
	Action   string `json:"action"`
	Status   string `json:"status"`
	Email    string `json:"email"`
	Occurred string `json:"occurredAt"`
	Machine  any    `json:"machine"`
}
type ActivityPage struct {
	ServerTime string     `json:"serverTime"`
	Entries    []Activity `json:"entries"`
	Cursor     *string    `json:"nextCursor"`
}
type cursor struct {
	V       int    `json:"v"`
	Created string `json:"createdAt"`
	ID      string `json:"id"`
}

var mapping = map[string][3]string{"checkout": {"web", "checkout", "reserved"}, "login": {"web", "login", "logged_in"}, "logout": {"web", "logout", "logged_out"}, "session_open": {"physical", "login", "logged_in"}, "session_close": {"physical", "logout", "logged_out"}, "password_timeout": {"physical", "timeout", "password_timeout"}}

func (s *Service) Activity(ctx context.Context, p url.Values) (ActivityPage, error) {
	out := ActivityPage{ServerTime: stamp(s.Now().UnixMilli()), Entries: []Activity{}}
	for k, v := range p {
		if k != "source" && k != "action" && k != "email" && k != "cursor" || len(v) != 1 {
			return out, fail(400, "Invalid or repeated activity filter")
		}
	}
	source, action := p.Get("source"), p.Get("action")
	if source != "" && source != "all" && source != "web" && source != "physical" {
		return out, fail(400, "Invalid source")
	}
	if action != "" && action != "all" && action != "checkout" && action != "login" && action != "logout" && action != "timeout" {
		return out, fail(400, "Invalid action")
	}
	args := []any{}
	events := []string{}
	for event, m := range mapping {
		if (source == "" || source == "all" || source == m[0]) && (action == "" || action == "all" || action == m[1]) {
			events = append(events, "?")
			args = append(args, event)
		}
	}
	if len(events) == 0 {
		return out, nil
	}
	q := `SELECT a.id,a.event,a.student_email,a.created_at,m.id,m.name FROM audit_log a LEFT JOIN machines m ON a.machine_id=m.id WHERE a.student_email IS NOT NULL AND a.event IN (` + strings.Join(events, ",") + ")"
	if email := p.Get("email"); email != "" {
		if len(email) > 254 {
			return out, fail(400, "Email too long")
		}
		q += " AND LOWER(a.student_email)=?"
		args = append(args, lower(email))
	}
	if v := p.Get("cursor"); v != "" {
		b, e := base64.RawURLEncoding.DecodeString(v)
		var c cursor
		if e != nil || len(v) > 512 || base64.RawURLEncoding.EncodeToString(b) != v || json.Unmarshal(b, &c) != nil || c.V != 1 || !CredentialID.MatchString(c.ID) {
			return out, fail(400, "Invalid cursor")
		}
		t, e := time.Parse("2006-01-02T15:04:05.000Z", c.Created)
		if e != nil || stamp(t.UnixMilli()) != c.Created {
			return out, fail(400, "Invalid cursor")
		}
		q += " AND (a.created_at<? OR (a.created_at=? AND a.id<?))"
		args = append(args, t.UnixMilli(), t.UnixMilli(), c.ID)
	}
	q += " ORDER BY a.created_at DESC,a.id DESC LIMIT 51"
	r, e := s.Store.DB.QueryContext(ctx, q, args...)
	if e != nil {
		return out, e
	}
	defer r.Close()
	for r.Next() {
		var v Activity
		var event string
		var at int64
		var mid, name *string
		if e = r.Scan(&v.ID, &event, &v.Email, &at, &mid, &name); e != nil {
			return out, e
		}
		m := mapping[event]
		v.Source = m[0]
		v.Action = m[1]
		v.Status = m[2]
		v.Occurred = stamp(at)
		if mid != nil {
			v.Machine = map[string]string{"id": *mid, "name": *name}
		}
		out.Entries = append(out.Entries, v)
	}
	if len(out.Entries) > 50 {
		out.Entries = out.Entries[:50]
		last := out.Entries[49]
		b, _ := json.Marshal(cursor{1, last.Occurred, last.ID})
		v := base64.RawURLEncoding.EncodeToString(b)
		out.Cursor = &v
	}
	return out, r.Err()
}
