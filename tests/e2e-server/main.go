// This disposable fixture is never linked into or packaged with labgate.
package main

import (
	"context"
	"fmt"
	"labgate/internal/config"
	"labgate/internal/core"
	"labgate/internal/migration"
	"labgate/internal/server"
	"labgate/internal/store"
	"labgate/web"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type provision struct{}

func (provision) Issue(context.Context, core.Machine, string, int64, string) error { return nil }
func (provision) Revoke(context.Context, core.Machine, string) error               { return nil }
func main() {
	dir, e := os.MkdirTemp("", "labgate-e2e-")
	must(e)
	defer os.RemoveAll(dir)
	p := filepath.Join(dir, "db")
	_, e = migration.Run(migration.Options{Path: p})
	must(e)
	db, e := store.Open(p)
	must(e)
	defer db.Close()
	c := config.Defaults()
	c.Origin = "http://127.0.0.1:3100"
	c.Admins = []string{"admin@ubu.ac.th"}
	c.RegistrationSecret = store.Random(32)
	c.CronSecret = store.Random(32)
	svc := core.New(db, c, provision{})
	app := server.New(svc, web.Handler())
	handler := app.Handler()
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/__fixture/") {
			switch r.URL.Path {
			case "/__fixture/reset":
				db.DB.Exec("DELETE FROM guest_credentials; DELETE FROM audit_log; DELETE FROM machines; DELETE FROM go_sessions; DELETE FROM go_pairings")
				db.DB.Exec("INSERT INTO machines(id,name,tailscale_ip,ssh_host_key_sha256,webhook_token,status,last_heartbeat) VALUES(?,?,?,?,?,'available',?)", "machine_abcdefghijklmnop", "Desktop 01", "100.64.0.1", "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", store.Random(32), time.Now().UnixMilli())
			case "/__fixture/login":
				role := r.URL.Query().Get("role")
				email := "student@ubu.ac.th"
				if role == "admin" {
					email = "admin@ubu.ac.th"
				}
				raw := store.Random(32)
				db.DB.Exec("INSERT INTO go_sessions(token_hash,email,name,expires_at,kind) VALUES(?,?,?,?,'web')", store.Hash(raw), email, "Test "+role, time.Now().Add(time.Hour).UnixMilli())
				http.SetCookie(w, &http.Cookie{Name: "labgate_session", Value: raw, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode})
				http.Redirect(w, r, "/", 302)
			case "/__fixture/expire":
				db.DB.Exec("UPDATE guest_credentials SET expires_at=0")
			default:
				w.WriteHeader(404)
			}
			return
		}
		handler.ServeHTTP(w, r)
	})
	fmt.Println("Disposable browser fixture listening on 127.0.0.1:3100")
	must(http.ListenAndServe("127.0.0.1:3100", nil))
}
func must(e error) {
	if e != nil {
		panic(e)
	}
}
