package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"labgate/internal/core"
	"labgate/internal/store"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type User struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	Kind  string `json:"-"`
}
type Auth struct {
	core     *core.Service
	mu       sync.Mutex
	provider *oidc.Provider
	oauth    oauth2.Config
	// bindKey authenticates OAuth request cookies for this process only.
	bindKey []byte
}

// maxPendingPairings bounds unapproved CLI pairings kept for five minutes.
const maxPendingPairings = 1024

func NewAuth(c *core.Service) *Auth {
	return &Auth{core: c, bindKey: []byte(store.Random(32)), oauth: oauth2.Config{ClientID: c.Config.GoogleID, ClientSecret: c.Config.GoogleSecret, RedirectURL: c.Config.Origin + "/api/auth/callback/google", Endpoint: google.Endpoint, Scopes: []string{oidc.ScopeOpenID, "email", "profile"}}}
}
func equal(a, b string) bool {
	return a != "" && b != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
func (a *Auth) Session(ctx context.Context, r *http.Request) (User, string, error) {
	raw := token(r)
	if raw == "" {
		if c, e := r.Cookie("labgate_session"); e == nil {
			raw = c.Value
		}
	}
	var u User
	if raw == "" {
		return u, "", errors.New("unauthenticated")
	}
	e := a.core.Store.DB.QueryRowContext(ctx, "SELECT email,name,kind FROM go_sessions WHERE token_hash=? AND expires_at>?", store.Hash(raw), store.Time(a.core.Now())).Scan(&u.Email, &u.Name, &u.Kind)
	if e != nil || !a.core.Config.Allowed(u.Email) {
		return u, "", errors.New("unauthenticated")
	}
	if token(r) != "" && u.Kind != "cli" {
		return User{}, "", errors.New("wrong session kind")
	}
	if token(r) == "" && u.Kind != "web" {
		return User{}, "", errors.New("wrong session kind")
	}
	return u, raw, nil
}
func (a *Auth) CSRF(r *http.Request, raw, kind string) bool {
	if kind == "cli" && token(r) != "" {
		return true
	}
	return r.Header.Get("Origin") == a.core.Config.Origin && equal(r.Header.Get("X-CSRF-Token"), store.Hash(raw+"csrf"))
}
func (a *Auth) cookie(w http.ResponseWriter, name, v string, age int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: v, Path: "/", MaxAge: age, HttpOnly: true, Secure: strings.HasPrefix(a.core.Config.Origin, "https://"), SameSite: http.SameSiteLaxMode})
}

// bind returns state.nonce.verifier.expiry.mac; every part is base64url or digits.
func (a *Auth) bind(state, nonce, verifier string, expires time.Time) string {
	v := state + "." + nonce + "." + verifier + "." + strconv.FormatInt(store.Time(expires), 10)
	m := hmac.New(sha256.New, a.bindKey)
	m.Write([]byte(v))
	return v + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
func (a *Auth) unbind(cookie, state string) (string, string, bool) {
	f := strings.Split(cookie, ".")
	if len(f) != 5 || f[1] == "" || f[2] == "" || !equal(f[0], state) {
		return "", "", false
	}
	expires, e := strconv.ParseInt(f[3], 10, 64)
	if e != nil || expires <= store.Time(a.core.Now()) {
		return "", "", false
	}
	m := hmac.New(sha256.New, a.bindKey)
	m.Write([]byte(strings.Join(f[:4], ".")))
	mac, e := base64.RawURLEncoding.DecodeString(f[4])
	if e != nil || !hmac.Equal(mac, m.Sum(nil)) {
		return "", "", false
	}
	return f[1], f[2], true
}
func (a *Auth) getProvider(ctx context.Context) (*oidc.Provider, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.provider != nil {
		return a.provider, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	p, e := oidc.NewProvider(ctx, "https://accounts.google.com")
	if e == nil {
		a.provider = p
	}
	return p, e
}
func (a *Auth) Handle(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	switch r.URL.Path {
	case "/api/auth/sign-in/google":
		if r.Method != "GET" {
			w.WriteHeader(405)
			return
		}
		// The request binding lives only in the browser's HttpOnly cookie, so
		// unauthenticated sign-in needs no server state or shared rate limit.
		state, nonce, verifier := store.Random(32), store.Random(32), oauth2.GenerateVerifier()
		a.cookie(w, "labgate_oauth", a.bind(state, nonce, verifier, a.core.Now().Add(5*time.Minute)), 300)
		http.Redirect(w, r, a.oauth.AuthCodeURL(state, oauth2.SetAuthURLParam("nonce", nonce), oauth2.SetAuthURLParam("hd", a.core.Config.Domain), oauth2.S256ChallengeOption(verifier)), 302)
	case "/api/auth/callback/google":
		if r.Method != "GET" {
			w.WriteHeader(405)
			return
		}
		c, e := r.Cookie("labgate_oauth")
		var nonce, verifier string
		ok := false
		if e == nil {
			nonce, verifier, ok = a.unbind(c.Value, r.URL.Query().Get("state"))
		}
		if !ok {
			write(w, 400, map[string]string{"error": "Invalid or expired OAuth state; sign in again"})
			return
		}
		a.cookie(w, "labgate_oauth", "", -1)
		bounded, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		tok, e := a.oauth.Exchange(bounded, r.URL.Query().Get("code"), oauth2.VerifierOption(verifier))
		if e != nil {
			write(w, 502, map[string]string{"error": "Google token exchange failed; retry sign-in"})
			return
		}
		raw, ok := tok.Extra("id_token").(string)
		if !ok {
			w.WriteHeader(403)
			return
		}
		p, e := a.getProvider(bounded)
		if e != nil {
			write(w, 502, map[string]string{"error": "Google identity discovery failed"})
			return
		}
		id, e := p.Verifier(&oidc.Config{ClientID: a.core.Config.GoogleID}).Verify(bounded, raw)
		if e != nil || !equal(id.Nonce, nonce) {
			write(w, 403, map[string]string{"error": "Google identity could not be verified"})
			return
		}
		var claims struct {
			Email    string `json:"email"`
			Verified bool   `json:"email_verified"`
			Name     string `json:"name"`
			HD       string `json:"hd"`
		}
		if id.Claims(&claims) != nil || !claims.Verified || !a.core.Config.Allowed(claims.Email) || claims.HD != a.core.Config.Domain {
			write(w, 403, map[string]string{"error": "A verified university Google account is required"})
			return
		}
		u := User{Email: strings.ToLower(claims.Email), Name: claims.Name, Kind: "web"}
		session, e := a.createSession(ctx, u)
		if e != nil {
			problem(w, e)
			return
		}
		a.cookie(w, "labgate_session", session, 7*86400)
		http.Redirect(w, r, "/", 302)
	case "/api/auth/sign-out":
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		u, raw, e := a.Session(ctx, r)
		if e != nil {
			a.cookie(w, "labgate_session", "", -1)
			write(w, 200, map[string]bool{"ok": true})
			return
		}
		if !a.CSRF(r, raw, u.Kind) {
			w.WriteHeader(403)
			return
		}
		e = a.core.Store.Tx(ctx, func(t *sql.Tx) error {
			res, e := t.ExecContext(ctx, "DELETE FROM go_sessions WHERE token_hash=?", store.Hash(raw))
			if e != nil {
				return e
			}
			n, _ := res.RowsAffected()
			if n > 0 {
				return core.Audit(ctx, t, "", u.Email, "logout", "", store.Time(a.core.Now()))
			}
			return nil
		})
		if e != nil {
			problem(w, e)
			return
		}
		a.cookie(w, "labgate_session", "", -1)
		write(w, 200, map[string]bool{"ok": true})
	default:
		w.WriteHeader(404)
	}
}
func (a *Auth) createSession(ctx context.Context, u User) (string, error) {
	raw := store.Random(32)
	e := a.core.Store.Tx(ctx, func(t *sql.Tx) error {
		now := store.Time(a.core.Now())
		if _, e := t.ExecContext(ctx, "INSERT INTO go_sessions(token_hash,email,name,expires_at,kind) VALUES(?,?,?,?,?)", store.Hash(raw), u.Email, u.Name, store.Time(a.core.Now().Add(7*24*time.Hour)), u.Kind); e != nil {
			return e
		}
		var id string
		e := t.QueryRowContext(ctx, `SELECT id FROM user WHERE LOWER(email)=?`, u.Email).Scan(&id)
		if e == sql.ErrNoRows {
			_, e = t.ExecContext(ctx, `INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)`, store.ID(), u.Name, u.Email, now, now)
		}
		if e != nil {
			return e
		}
		return core.Audit(ctx, t, "", u.Email, "login", "", now)
	})
	return raw, e
}
func (a *Auth) Pair(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	switch r.URL.Path {
	case "/api/cli/start":
		var b struct {
			Secret string `json:"secret"`
		}
		if e := body(w, r, &b); e != nil {
			problem(w, e)
			return
		}
		if len(b.Secret) < 32 || len(b.Secret) > 128 {
			w.WriteHeader(400)
			return
		}
		id := store.Random(24)
		code := strings.ToUpper(store.Random(6))
		expires := store.Time(a.core.Now().Add(5 * time.Minute))
		e := a.core.Store.Tx(ctx, func(t *sql.Tx) error {
			if _, e := t.ExecContext(ctx, "DELETE FROM go_pairings WHERE expires_at<=?", store.Time(a.core.Now())); e != nil {
				return e
			}
			// Bound unauthenticated state without a shared limiter: evict the
			// oldest unapproved pairings; approved ones await their own poll.
			if _, e := t.ExecContext(ctx, "DELETE FROM go_pairings WHERE id IN (SELECT id FROM go_pairings WHERE approved_at IS NULL ORDER BY expires_at DESC,id DESC LIMIT -1 OFFSET ?)", maxPendingPairings-1); e != nil {
				return e
			}
			_, e := t.ExecContext(ctx, "INSERT INTO go_pairings(id,secret_hash,code,expires_at) VALUES(?,?,?,?)", id, store.Hash(b.Secret), code, expires)
			return e
		})
		if e != nil {
			problem(w, e)
			return
		}
		write(w, 200, map[string]any{"id": id, "code": code, "verificationUrl": a.core.Config.Origin + "/cli/approve", "expiresIn": 300})
	case "/api/cli/approve":
		u, raw, e := a.Session(ctx, r)
		if e != nil {
			w.WriteHeader(401)
			return
		}
		if !a.core.Config.Admin(u.Email) || u.Kind != "web" || !a.CSRF(r, raw, u.Kind) {
			w.WriteHeader(403)
			return
		}
		var b struct {
			Code string `json:"code"`
		}
		if e = body(w, r, &b); e != nil {
			problem(w, e)
			return
		}
		res, e := a.core.Store.DB.ExecContext(ctx, "UPDATE go_pairings SET email=?,name=?,approved_at=? WHERE code=? AND expires_at>? AND approved_at IS NULL", u.Email, u.Name, store.Time(a.core.Now()), b.Code, store.Time(a.core.Now()))
		if e != nil {
			problem(w, e)
			return
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			write(w, 400, map[string]string{"error": "Pairing code expired, unknown, or already approved"})
			return
		}
		write(w, 200, map[string]bool{"ok": true})
	case "/api/cli/poll":
		var b struct {
			ID     string `json:"id"`
			Secret string `json:"secret"`
		}
		if e := body(w, r, &b); e != nil {
			problem(w, e)
			return
		}
		raw := ""
		pending := false
		e := a.core.Store.Tx(ctx, func(t *sql.Tx) error {
			var secret string
			var email, name sql.NullString
			e := t.QueryRowContext(ctx, "SELECT secret_hash,email,name FROM go_pairings WHERE id=? AND expires_at>?", b.ID, store.Time(a.core.Now())).Scan(&secret, &email, &name)
			if e != nil || !equal(secret, store.Hash(b.Secret)) {
				return &core.Error{Status: 400, Message: "Pairing expired or invalid"}
			}
			if !email.Valid {
				pending = true
				return nil
			}
			if !a.core.Config.Admin(email.String) {
				return &core.Error{Status: 403, Message: "Administrator access removed"}
			}
			raw = store.Random(32)
			if _, e = t.ExecContext(ctx, "DELETE FROM go_pairings WHERE id=?", b.ID); e != nil {
				return e
			}
			if _, e = t.ExecContext(ctx, "INSERT INTO go_sessions(token_hash,email,name,expires_at,kind) VALUES(?,?,?,?, 'cli')", store.Hash(raw), email.String, name.String, store.Time(a.core.Now().Add(7*24*time.Hour))); e != nil {
				return e
			}
			return core.Audit(ctx, t, "", email.String, "login", "CLI login", store.Time(a.core.Now()))
		})
		if e != nil {
			problem(w, e)
			return
		}
		if pending {
			write(w, 202, map[string]string{"status": "pending"})
			return
		}
		write(w, 200, map[string]string{"token": raw})
	default:
		w.WriteHeader(404)
	}
}
