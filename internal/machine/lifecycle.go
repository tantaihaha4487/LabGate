package machine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

func ReadPassword(r io.Reader) (string, error) {
	b, e := io.ReadAll(io.LimitReader(r, 131))
	if e != nil || len(b) > 129 || len(b) == 0 || b[len(b)-1] != '\n' || strings.Count(string(b), "\n") != 1 {
		return "", errors.New("exactly one password line required")
	}
	p := string(b[:len(b)-1])
	if !passwordRE.MatchString(p) {
		return "", errors.New("unsupported password")
	}
	return p, nil
}
func (m *Runtime) Account(ctx context.Context, args []string, input io.Reader) error {
	if len(args) < 2 || !idRE.MatchString(args[1]) {
		return errors.New("invalid generation command")
	}
	action, id := args[0], args[1]
	var password string
	deadline := int64(0)
	if action == "issue" {
		if len(args) != 3 {
			return errors.New("invalid issue command")
		}
		var e error
		deadline, e = strconv.ParseInt(args[2], 10, 64)
		if e != nil || !regexpDigits(args[2]) || len(args[2]) > 12 || deadline <= m.Now().Unix() || deadline > m.Now().Unix()+86460 {
			return errors.New("invalid deadline")
		}
		password, e = ReadPassword(input)
		if e != nil {
			return e
		}
		length, e := m.read("/etc/labgate/password-length", true)
		n, ne := strconv.Atoi(length)
		if e != nil || ne != nil || n < 5 || n > 128 || len(password) != n {
			return errors.New("password length mismatch")
		}
	} else if action != "revoke" || len(args) != 2 {
		return errors.New("invalid lifecycle action")
	}
	l, e := m.lock("guest.lock", false)
	if e != nil {
		return e
	}
	defer l.Close()
	// Uninstall removes local deadline enforcement, so a decommissioned endpoint never unlocks.
	// Checked under guest.lock: uninstall's boot cleanup re-locks after any issue that got here first.
	if _, e := os.Lstat(m.path(decommissioned)); action == "issue" && !os.IsNotExist(e) {
		return errors.New("endpoint decommissioned")
	}
	s, se := m.State()
	if se != nil && !os.IsNotExist(se) {
		m.recovery("corrupt-state", id)
		return se
	}
	active, e := m.sessions(ctx)
	if e != nil || active {
		return errors.New("guest session exists or cannot be inventoried")
	}
	if action == "issue" {
		if _, e = m.read("/var/lib/labgate/tombstones/"+id, false); e == nil {
			return errors.New("terminal generation cannot be reissued")
		} else if !os.IsNotExist(e) {
			return e
		}
		if se == nil && (s.State == "active" || s.State == "pending" && (s.ID != id || s.Deadline != deadline) || s.State == "revoked" && s.ID == id) {
			return errors.New("generation conflict")
		}
		if e = m.Secure(ctx); e != nil {
			m.recovery("issue-preparation-failed", id)
			return errors.New("local safety could not be established")
		}
		if e = m.clear("/run/labgate/pam-session"); e != nil {
			return e
		}
		if e = m.writeState(State{ID: id, Deadline: deadline, State: "pending"}); e != nil {
			return e
		}
		if e = m.resetAuthentication(ctx); e != nil {
			m.cmd(ctx, "passwd", "-l", "guest")
			m.recovery("issue-authentication-reset-failed", id)
			return e
		}
		if _, e = m.Run.Command(ctx, "guest:"+password+"\n", utilityPath("chpasswd")); e != nil {
			m.cmd(ctx, "passwd", "-l", "guest")
			m.recovery("issue-password-rotation-failed", id)
			return errors.New("password rotation failed")
		}
		if _, e = m.cmd(ctx, "passwd", "-u", "guest"); e != nil {
			m.cmd(ctx, "passwd", "-l", "guest")
			return errors.New("guest unlock failed")
		}
		locked, e := m.locked(ctx)
		if e != nil || locked {
			m.cmd(ctx, "passwd", "-l", "guest")
			return errors.New("guest unlock unconfirmed")
		}
		return m.clear("/var/lib/labgate/recovery-needed")
	}
	if se == nil && (s.State == "active" || s.ID != id && s.State != "revoked") {
		return errors.New("refusing to revoke active or different live generation")
	}
	if e = m.Secure(ctx); e != nil {
		m.recovery("revoke-local-safety-failed", id)
		return errors.New("local revocation unconfirmed")
	}
	if e = m.clear("/run/labgate/pam-session"); e != nil {
		return e
	}
	if se != nil || s.ID != id {
		s = State{ID: id, Deadline: m.Now().Unix(), State: "revoked"}
	} else {
		s.State = "revoked"
	}
	if e = m.writeState(s); e != nil {
		return e
	}
	return m.clear("/var/lib/labgate/recovery-needed")
}
func (m *Runtime) resetAuthentication(ctx context.Context) error {
	help, err := m.cmd(ctx, "chage", "--help")
	if err != nil {
		return err
	}
	args := []string{"--maxdays", "-1", "--warndays", "0", "--inactive", "-1", "--expiredate", "-1"}
	// Arch's PAM-enabled shadow tools omit --mindays. Empty/zero minimum
	// ages are equivalent; any nonzero value still fails postflight below.
	if strings.Contains(help, "--mindays") {
		args = append(args, "--mindays", "0")
	}
	args = append(args, "guest")
	if _, e := m.cmd(ctx, "chage", args...); e != nil {
		return e
	}
	v, e := m.cmd(ctx, "getent", "shadow", "guest")
	if e != nil {
		return e
	}
	f := strings.Split(v, ":")
	if len(f) != 9 || f[0] != "guest" || (f[3] != "0" && f[3] != "") || f[4] != "" || f[5] != "0" || f[6] != "" || f[7] != "" {
		return errors.New("guest password aging is not nonexpiring")
	}
	backends, e := m.read("/etc/labgate/auth-failure-backends", false)
	if e != nil {
		return e
	}
	if backends == "none" {
		return nil
	}
	seen := map[string]bool{}
	for _, b := range strings.Split(backends, ",") {
		if b != "faillock" && b != "pam_tally2" && b != "pam_tally" || seen[b] {
			return errors.New("unknown failure-counter backend")
		}
		seen[b] = true
		if _, e = m.cmd(ctx, b, "--user", "guest", "--reset"); e != nil {
			return errors.New("failure-counter reset failed")
		}
	}
	return nil
}
func ContextKey(ppid int, env func(string) string) string {
	v := fmt.Sprintf("%d\x00%s\x00%s\x00%s\x00%s\x00", ppid, env("PAM_SERVICE"), env("PAM_TTY"), env("PAM_RHOST"), env("PAM_USER"))
	h := sha256.Sum256([]byte(v))
	return hex.EncodeToString(h[:])
}
func (m *Runtime) failSecure(ctx context.Context, reason, id string) error {
	m.Secure(ctx)
	m.clear("/run/labgate/pam-session")
	m.recovery(reason, id)
	return errors.New("local lifecycle recovery required")
}
func (m *Runtime) PAM(ctx context.Context, env func(string) string, ppid int) error {
	if env("PAM_USER") != "guest" {
		return nil
	}
	l, e := m.lock("guest.lock", false)
	if e != nil {
		return e
	}
	defer l.Close()
	s, se := m.State()
	key := ContextKey(ppid, env)
	switch env("PAM_TYPE") {
	case "open_session":
		if se != nil {
			return m.failSecure(ctx, "pam-open-state-unavailable", "")
		}
		if s.State == "active" {
			return errors.New("concurrent guest open rejected")
		}
		if s.State != "pending" {
			return m.failSecure(ctx, "pam-open-not-pending", s.ID)
		}
		now := m.Now().Unix()
		if now < s.Changed {
			return m.failSecure(ctx, "pam-open-clock-rollback", s.ID)
		}
		if now >= s.Deadline {
			if e = m.Secure(ctx); e != nil {
				return m.failSecure(ctx, "pam-open-expired-safety-failed", s.ID)
			}
			s.State = "revoked"
			if e = m.writeState(s); e != nil {
				return e
			}
			m.clear("/run/labgate/pam-session")
			m.Queue("credential-expired", s.ID, 3)
			return errors.New("password deadline expired")
		}
		locked, e := m.locked(ctx)
		if e != nil || locked {
			return m.failSecure(ctx, "pam-open-account-locked", s.ID)
		}
		if e = m.kill(ctx); e != nil {
			return m.failSecure(ctx, "pam-open-process-cleanup-failed", s.ID)
		}
		if e = m.home(ctx); e != nil {
			return m.failSecure(ctx, "pam-open-home-failed", s.ID)
		}
		if e = m.atomic("/run/labgate/pam-session", s.ID+"\t"+key+"\n"); e != nil {
			return m.failSecure(ctx, "pam-open-marker-failed", s.ID)
		}
		s.State = "active"
		if e = m.writeState(s); e != nil {
			return m.failSecure(ctx, "pam-open-write-failed", s.ID)
		}
		m.clear("/var/lib/labgate/recovery-needed")
		if e = m.Queue("session-open", s.ID, 2); e != nil {
			m.recovery("outbox-publication-failed", s.ID)
		}
		return nil
	case "close_session":
		marker, me := m.read("/run/labgate/pam-session", false)
		f := strings.Split(marker, "\t")
		if me == nil && len(f) == 2 && idRE.MatchString(f[0]) && isContextKey(f[1]) && f[1] != key {
			return nil
		}
		if e = m.Secure(ctx); e != nil {
			return m.failSecure(ctx, "pam-close-safety-failed", s.ID)
		}
		if se != nil {
			return m.failSecure(ctx, "pam-close-state-unavailable", s.ID)
		}
		previous := s.State
		s.State = "revoked"
		if e = m.writeState(s); e != nil {
			return m.failSecure(ctx, "pam-close-write-failed", s.ID)
		}
		if e = m.clear("/run/labgate/pam-session"); e != nil {
			return e
		}
		m.clear("/var/lib/labgate/recovery-needed")
		if previous != "revoked" || me == nil {
			if e = m.Queue("session-close", s.ID, 3); e != nil {
				m.recovery("outbox-publication-failed", s.ID)
			}
			return nil
		}
		return nil
	}
	return nil
}
func (m *Runtime) Cleanup(ctx context.Context, boot bool) error {
	l, e := m.lock("guest.lock", false)
	if e != nil {
		return e
	}
	defer l.Close()
	s, se := m.State()
	if se != nil {
		if e = m.Secure(ctx); e != nil {
			return m.failSecure(ctx, "cleanup-safety-failed", "")
		}
		m.clear("/run/labgate/pam-session")
		if !os.IsNotExist(se) {
			m.recovery("cleanup-corrupt-state", "")
			return se
		}
		return nil
	}
	if !boot {
		now := m.Now().Unix()
		if now < s.Changed {
			return m.failSecure(ctx, "cleanup-clock-rollback", s.ID)
		}
		switch s.State {
		case "pending":
			if now < s.Deadline {
				return nil
			}
		case "active":
			active, e := m.sessions(ctx)
			if e != nil {
				m.recovery("cleanup-session-unknown", s.ID)
				return e
			}
			if active || now-s.Changed < 120 {
				return nil
			}
		}
	}
	if e = m.Secure(ctx); e != nil {
		return m.failSecure(ctx, "cleanup-safety-failed", s.ID)
	}
	previous := s.State
	s.State = "revoked"
	if e = m.writeState(s); e != nil {
		return e
	}
	if e = m.clear("/run/labgate/pam-session"); e != nil {
		return e
	}
	m.clear("/var/lib/labgate/recovery-needed")
	if !boot && previous != "revoked" {
		event := "session-close"
		if previous == "pending" {
			event = "credential-expired"
		}
		return m.Queue(event, s.ID, 3)
	}
	return nil
}

func isContextKey(v string) bool {
	if len(v) != 64 {
		return false
	}
	for _, r := range v {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
