package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"labgate/internal/core"
	"labgate/internal/store"
	"log"
	"net/http"
	"strings"
	"time"
)

type Server struct {
	Core   *core.Service
	auth   *Auth
	static http.Handler
}

// Legacy machine installers compare these JSON records byte-for-byte.
type healthRecord struct {
	OK      bool   `json:"ok"`
	Service string `json:"service"`
	Version int    `json:"machineEnrollmentVersion"`
}
type readinessRecord struct {
	OK      bool   `json:"ok"`
	Service string `json:"service"`
	Version int    `json:"machineEnrollmentVersion"`
	Ready   bool   `json:"registrationReady"`
}

func New(c *core.Service, static http.Handler) *Server {
	s := &Server{Core: c, static: static}
	s.auth = NewAuth(c)
	return s
}
func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.handle) }
func write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func problem(w http.ResponseWriter, e error) {
	var v *core.Error
	if errors.As(e, &v) {
		write(w, v.Status, map[string]string{"error": v.Message})
	} else {
		write(w, 500, map[string]string{"error": "Operation failed; retry or check server diagnostics"})
	}
}
func body(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return &core.Error{Status: 400, Message: "Invalid or oversized JSON object"}
	}
	if e := d.Decode(new(any)); e != io.EOF {
		return &core.Error{Status: 400, Message: "Exactly one JSON object required"}
	}
	return nil
}
func token(r *http.Request) string {
	v := r.Header.Get("Authorization")
	if strings.HasPrefix(v, "Bearer ") {
		return strings.TrimPrefix(v, "Bearer ")
	}
	return ""
}
func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'")
	path := r.URL.Path
	ctx := r.Context()
	if path == "/api/health" && r.Method == "GET" {
		if e := s.Core.Store.Validate(); e != nil {
			write(w, 503, healthRecord{false, "labgate", 1})
			return
		}
		write(w, 200, healthRecord{true, "labgate", 1})
		return
	}
	if strings.HasPrefix(path, "/api/auth/") {
		s.auth.Handle(w, r)
		return
	}
	if strings.HasPrefix(path, "/api/cli/") {
		s.auth.Pair(w, r)
		return
	}
	if strings.HasPrefix(path, "/api/webhook/") {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		endpoint := strings.TrimPrefix(path, "/api/webhook/")
		if endpoint != "heartbeat" && endpoint != "session-open" && endpoint != "session-close" && endpoint != "credential-expired" {
			w.WriteHeader(404)
			return
		}
		var report core.Report
		if e := body(w, r, &report); e != nil {
			problem(w, e)
			return
		}
		status, e := s.Core.Webhook(ctx, token(r), endpoint, report)
		if e != nil {
			problem(w, e)
			return
		}
		write(w, 200, map[string]any{"ok": true, "status": status})
		return
	}
	if path == "/api/cron/sweep" {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		if !equal(token(r), s.Core.Config.CronSecret) {
			write(w, 401, map[string]string{"error": "Unauthorized"})
			return
		}
		v, e := s.Core.Sweep(ctx)
		if e != nil {
			problem(w, e)
			return
		}
		write(w, 200, v)
		return
	}
	registration := path == "/api/admin/register-machine"
	if registration && equal(token(r), s.Core.Config.RegistrationSecret) {
		s.enroll(w, r, "")
		return
	}
	if !strings.HasPrefix(path, "/api/") {
		if strings.HasPrefix(path, "/admin") {
			u, _, e := s.auth.Session(ctx, r)
			if e != nil {
				http.Redirect(w, r, "/login", 302)
				return
			}
			if !s.Core.Config.Admin(u.Email) {
				http.Redirect(w, r, "/", 302)
				return
			}
		}
		s.static.ServeHTTP(w, r)
		return
	}
	user, raw, e := s.auth.Session(ctx, r)
	if e != nil {
		write(w, 401, map[string]string{"error": "Unauthorized"})
		return
	}
	admin := s.Core.Config.Admin(user.Email)
	if strings.HasPrefix(path, "/api/admin/") && !admin {
		write(w, 403, map[string]string{"error": "Administrator required"})
		return
	}
	if r.Method != "GET" && !s.auth.CSRF(r, raw, user.Kind) {
		write(w, 403, map[string]string{"error": "Invalid request origin or CSRF token"})
		return
	}
	switch {
	case path == "/api/session" && r.Method == "GET":
		write(w, 200, map[string]any{"user": user, "isAdmin": admin, "csrfToken": store.Hash(raw + "csrf"), "adminEmails": func() []string {
			if admin {
				return s.Core.Config.Admins
			}
			return nil
		}()})
	case path == "/api/machines" && r.Method == "GET":
		v, e := s.Core.List(ctx, false)
		if e != nil {
			problem(w, e)
			return
		}
		public := []map[string]any{}
		for _, m := range v {
			public = append(public, map[string]any{"id": m.ID, "name": m.Name, "status": m.Status, "connectivity": m.Connectivity, "lastHeartbeat": m.Heartbeat})
		}
		write(w, 200, map[string]any{"machines": public})
	case path == "/api/checkout" && r.Method == "POST":
		var b struct {
			MachineID string `json:"machineId"`
		}
		if e = body(w, r, &b); e != nil {
			problem(w, e)
			return
		}
		if b.MachineID == "" {
			write(w, 400, map[string]string{"error": "machineId is required"})
			return
		}
		v, e := s.Core.Checkout(ctx, b.MachineID, user.Email)
		if e != nil {
			problem(w, e)
			return
		}
		write(w, 200, map[string]any{"username": v.Username, "password": v.Password, "expiresAt": v.Expires, "serverTime": s.Core.Now().UTC().Format(time.RFC3339Nano)})
	case path == "/api/checkout/expire" && r.Method == "POST":
		var b struct {
			MachineID string `json:"machineId"`
		}
		if e = body(w, r, &b); e != nil {
			problem(w, e)
			return
		}
		if b.MachineID == "" {
			write(w, 400, map[string]string{"error": "machineId is required"})
			return
		}
		now := s.Core.Now().UTC().Format(time.RFC3339Nano)
		var id string
		var expires int64
		e = s.Core.Store.DB.QueryRowContext(ctx, "SELECT id,expires_at FROM guest_credentials WHERE machine_id=? AND LOWER(student_email)=? AND revoked_at IS NULL", b.MachineID, strings.ToLower(user.Email)).Scan(&id, &expires)
		if e == sql.ErrNoRows {
			var hold sql.NullString
			err := s.Core.Store.DB.QueryRowContext(ctx, "SELECT safety_hold_credential_id FROM machines WHERE id=?", b.MachineID).Scan(&hold)
			if err != nil && err != sql.ErrNoRows {
				problem(w, err)
				return
			}
			status := "already_released"
			if hold.Valid {
				status = "held"
			}
			write(w, 200, map[string]any{"ok": true, "status": status, "serverTime": now})
			return
		}
		if e != nil {
			problem(w, e)
			return
		}
		if expires > s.Core.Now().UnixMilli() {
			write(w, 409, map[string]any{"error": "Credential has not expired yet.", "expiresAt": time.UnixMilli(expires).UTC().Format(time.RFC3339Nano), "serverTime": now})
			return
		}
		v, e := s.Core.Expire(ctx, id)
		if e != nil {
			problem(w, e)
			return
		}
		if v.Status == "retry" {
			write(w, 503, map[string]any{"error": "The guest account lock is still pending.", "status": v.Status, "serverTime": now})
			return
		}
		write(w, 200, map[string]any{"ok": true, "status": v.Status, "serverTime": now})

	case path == "/api/admin/machines" && r.Method == "GET":
		v, e := s.Core.List(ctx, true)
		if e != nil {
			problem(w, e)
			return
		}
		write(w, 200, map[string]any{"machines": v, "adminEmails": s.Core.Config.Admins, "serverTime": s.Core.Now().UTC().Format(time.RFC3339Nano)})
	case path == "/api/admin/logs" && r.Method == "GET":
		v, e := s.Core.Activity(ctx, r.URL.Query())
		if e != nil {
			problem(w, e)
			return
		}
		write(w, 200, v)
	case strings.HasPrefix(path, "/api/admin/machines/") && strings.HasSuffix(path, "/visibility") && r.Method == "PATCH":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/api/admin/machines/"), "/visibility")
		var b struct {
			Hidden *bool `json:"hidden"`
		}
		if e = body(w, r, &b); e != nil {
			problem(w, e)
			return
		}
		if b.Hidden == nil {
			write(w, 400, map[string]string{"error": "hidden must be boolean"})
			return
		}
		v, e := s.Core.Visibility(ctx, id, *b.Hidden, user.Email)
		if e != nil {
			problem(w, e)
			return
		}
		write(w, 200, map[string]any{"machineId": id, "status": v, "hidden": *b.Hidden})
	case registration:
		s.enroll(w, r, user.Email)
	default:
		write(w, 404, map[string]string{"error": "Not found"})
	}
}
func (s *Server) enroll(w http.ResponseWriter, r *http.Request, email string) {
	if r.Method == "GET" {
		write(w, 200, readinessRecord{true, "labgate", 1, true})
		return
	}
	if r.Method != "POST" && r.Method != "PATCH" {
		w.WriteHeader(405)
		return
	}
	var v core.Identity
	if e := body(w, r, &v); e != nil {
		problem(w, e)
		return
	}
	out, e := s.Core.Enroll(r.Context(), v, r.Method == "PATCH", email)
	if e != nil {
		problem(w, e)
		return
	}
	write(w, 200, out)
}
func (s *Server) SweepLoop(ctx context.Context) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if _, e := s.Core.Sweep(ctx); e != nil {
				log.Print("LabGate sweep failed; safety state retained, retry scheduled")
			}
		}
	}
}
