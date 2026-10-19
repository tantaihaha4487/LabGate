package machine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"labgate/internal/config"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func (m *Runtime) post(ctx context.Context, endpoint string, v any) error {
	origin, e := m.read("/etc/labgate/api-url", true)
	if e != nil || !config.Origin(origin) {
		return errors.New("invalid API origin")
	}
	token, e := m.read("/etc/labgate/webhook-token", true)
	if e != nil || !config.ValidBearer(token) {
		return errors.New("invalid webhook token")
	}
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "POST", origin+"/api/webhook/"+endpoint, bytes.NewReader(b))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, e := client.Do(req)
	if e != nil {
		return errors.New("webhook delivery failed")
	}
	defer res.Body.Close()
	io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return errors.New("webhook not acknowledged")
	}
	return nil
}
func (m *Runtime) Flush(ctx context.Context) error {
	l, e := m.lock("webhook-outbox.lock", true)
	if e != nil {
		return nil
	}
	defer l.Close()
	entries, e := os.ReadDir(m.path("/var/lib/labgate/outbox"))
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		parts := sequenceRE.FindStringSubmatch(entry.Name())
		if parts == nil {
			return errors.New("unknown or legacy outbox event retained")
		}
		n, _ := strconv.ParseInt(parts[1], 10, 64)
		if n <= 0 {
			return errors.New("invalid sequence retained")
		}
		path := "/var/lib/labgate/outbox/" + entry.Name()
		v, e := m.read(path, true)
		if e != nil {
			return e
		}
		f := strings.Split(v, "\t")
		if len(f) != 3 || !idRE.MatchString(f[1]) {
			return errors.New("invalid queued event retained")
		}
		ver, e := strconv.Atoi(f[2])
		if e != nil || f[0] == "session-open" && ver != 2 || (f[0] == "session-close" || f[0] == "credential-expired") && ver != 3 || f[0] != "session-open" && f[0] != "session-close" && f[0] != "credential-expired" {
			return errors.New("invalid event version retained")
		}
		if e = m.post(ctx, f[0], map[string]any{"credentialId": f[1], "stateVersion": ver}); e != nil {
			return e
		}
		if e = m.clear(path); e != nil {
			return e
		}
		d, e := os.Open(m.path("/var/lib/labgate/outbox"))
		if e != nil {
			return e
		}
		e = d.Sync()
		d.Close()
		if e != nil {
			return e
		}
	}
	return nil
}
func (m *Runtime) Heartbeat(ctx context.Context) error {
	l, e := m.lock("guest.lock", false)
	if e != nil {
		return e
	}
	s, se := m.State()
	if se != nil {
		if e = m.Secure(ctx); e != nil {
			l.Close()
			m.recovery("heartbeat-safety-failed", "")
			return e
		}
		if e = m.clear("/run/labgate/pam-session"); e != nil {
			l.Close()
			m.recovery("heartbeat-pam-clear-failed", "")
			return e
		}
		if !os.IsNotExist(se) {
			l.Close()
			m.recovery("heartbeat-corrupt-state", "")
			return se
		}
	}
	active, ae := m.sessions(ctx)
	if ae != nil {
		if se != nil || s.State != "active" {
			l.Close()
			return errors.New("session inventory unknown")
		}
		active = true
	}
	locked, e := m.locked(ctx)
	if e != nil {
		l.Close()
		return e
	}
	var id, state any
	var ver any
	if se == nil {
		id = s.ID
		state = s.State
		ver = s.Version
	}
	report := map[string]any{"credentialId": id, "state": state, "stateVersion": ver, "guestLocked": locked, "sessionActive": active}
	l.Close()
	return m.post(ctx, "heartbeat", report)
}
func Dispatch(original string, input io.Reader) ([]string, string, error) {
	f := strings.Split(original, " ")
	if strings.Join(f, " ") != original || len(f) < 4 || f[0] != "sudo" || f[1] != "/usr/local/sbin/guest-account.sh" || !idRE.MatchString(f[3]) {
		return nil, "", errors.New("command denied")
	}
	if f[2] == "revoke" && len(f) == 4 {
		return []string{"--", f[1], f[2], f[3]}, "", nil
	}
	if f[2] == "issue" && len(f) == 5 {
		if len(f[4]) > 12 || !regexpDigits(f[4]) {
			return nil, "", errors.New("invalid deadline")
		}
		p, e := ReadPassword(input)
		if e != nil {
			return nil, "", e
		}
		return []string{"--", f[1], f[2], f[3], f[4]}, p + "\n", nil
	}
	return nil, "", errors.New("command denied")
}
func regexpDigits(v string) bool {
	if v == "" {
		return false
	}
	for _, r := range v {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
