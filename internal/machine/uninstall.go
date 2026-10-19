package machine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

var sessionHooks = map[string]bool{
	"session required pam_exec.so quiet type=open_session /usr/local/sbin/guest-session-hook.sh":  true,
	"session required pam_exec.so quiet type=close_session /usr/local/sbin/guest-session-hook.sh": true,
	"session required pam_exec.so quiet /usr/local/sbin/guest-session-hook.sh":                    true,
	"session required pam_exec.so /usr/local/sbin/guest-session-hook.sh":                          true,
}

const decommissioned = "/var/lib/labgate/decommissioned"

// Uninstall decommissions a drained endpoint while retaining its safety controls.
func (m *Runtime) Uninstall(ctx context.Context, out io.Writer) error {
	recorded, err := m.read("/etc/labgate/pam-file", false)
	if err != nil {
		return err
	}
	if filepath.Dir(recorded) != "/etc/pam.d" {
		return errors.New("recorded PAM file is outside /etc/pam.d")
	}
	files := map[string][]byte{}
	err = filepath.WalkDir(m.path("/etc/pam.d"), func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			return nil
		}
		rel, e := filepath.Rel(m.Root, p)
		if e != nil {
			return e
		}
		rel = "/" + rel
		if d.Type()&os.ModeSymlink != 0 {
			if rel == recorded {
				return errors.New("recorded PAM file is a symlink")
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if e = m.trusted(rel, false); e != nil {
			return e
		}
		b, e := os.ReadFile(p)
		if e != nil {
			return e
		}
		if rel == recorded || containsHook(b) {
			files[rel] = b
		}
		return nil
	})
	if err != nil {
		return err
	}
	if _, ok := files[recorded]; !ok {
		return errors.New("recorded PAM file is missing")
	}
	for _, guard := range []struct{ file, line string }{
		{"chfn", "auth requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh"},
		{"chsh", "auth requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh"},
		{"passwd", "password requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh"},
	} {
		p := "/etc/pam.d/" + guard.file
		if err = m.trusted(p, false); err != nil {
			return err
		}
		b, e := os.ReadFile(m.path(p))
		if e != nil {
			return e
		}
		count := 0
		for _, line := range strings.Split(string(b), "\n") {
			if line == guard.line {
				count++
			}
		}
		if count != 1 {
			return fmt.Errorf("guest account-change guard missing or duplicated: %s", p)
		}
		files[p] = b
	}
	// Reject occupied endpoints before boot cleanup, which terminates guest sessions.
	active, err := m.sessions(ctx)
	if err != nil {
		return err
	}
	if active {
		return errors.New("drain the active guest session before uninstalling")
	}
	// Refuse remote issue before local enforcement goes away; revoke keeps working.
	if err = m.atomic(decommissioned, m.Now().UTC().Format(time.RFC3339)+"\n"); err != nil {
		return err
	}
	// Stop writers before cleanup and editing PAM. Any error leaves safety controls in place.
	for _, unit := range []string{"guest-cleanup.timer", "guest-heartbeat.timer", "guest-webhook-flush.path", "guest-webhook-flush.timer"} {
		if _, err = m.cmd(ctx, "systemctl", "disable", "--now", unit); err != nil {
			return fmt.Errorf("disable %s: %w", unit, err)
		}
	}
	for _, unit := range []string{"guest-cleanup.service", "guest-heartbeat.service", "guest-webhook-flush.service"} {
		if _, err = m.cmd(ctx, "systemctl", "stop", unit); err != nil {
			return err
		}
	}
	if err = m.Cleanup(ctx, true); err != nil {
		return err
	}
	if _, err = m.cmd(ctx, "systemctl", "enable", "--now", "guest-boot-lock.service"); err != nil {
		return err
	}
	lock, err := m.lock("guest.lock", false)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = m.verifyUninstallSafe(ctx); err != nil {
		return err
	}
	if err = safeDir(m.path("/root"), true); err != nil {
		return err
	}
	backup, err := os.MkdirTemp(m.path("/root"), "labgate-uninstall-"+m.Now().UTC().Format("20060102-150405")+"-")
	if err != nil {
		return err
	}
	for p, b := range files {
		destination := filepath.Join(backup, p)
		if err = os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			return err
		}
		info, e := os.Stat(m.path(p))
		if e != nil {
			return e
		}
		if err = os.WriteFile(destination, b, info.Mode().Perm()); err != nil {
			return err
		}
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			if err = os.Chown(destination, int(stat.Uid), int(stat.Gid)); err != nil {
				return err
			}
		}
	}
	fmt.Fprintln(out, "PAM backup:", backup)
	for p, b := range files {
		if !containsHook(b) {
			continue
		}
		current, e := os.ReadFile(m.path(p))
		if e != nil {
			return e
		}
		if string(current) != string(b) {
			return fmt.Errorf("PAM file changed since backup: %s", p)
		}
		if err = m.rewritePAM(p, stripHooks(b)); err != nil {
			return err
		}
	}
	if err = m.verifyUninstallSafe(ctx); err != nil {
		return err
	}
	fmt.Fprintln(out, "LabGate machine integration removed. Accounts, SSH restrictions, boot lock, helpers, configuration, and local state retained.")
	return nil
}
func containsHook(b []byte) bool {
	for _, line := range strings.Split(string(b), "\n") {
		if sessionHooks[line] {
			return true
		}
	}
	return false
}
func stripHooks(b []byte) []byte {
	lines := strings.SplitAfter(string(b), "\n")
	var out strings.Builder
	for _, line := range lines {
		if !sessionHooks[strings.TrimSuffix(line, "\n")] {
			out.WriteString(line)
		}
	}
	return []byte(out.String())
}
func (m *Runtime) rewritePAM(p string, b []byte) error {
	if err := m.trusted(p, false); err != nil {
		return err
	}
	info, err := os.Stat(m.path(p))
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(m.path(p)), ".labgate-uninstall-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = f.Write(b); err != nil {
		return err
	}
	stat := info.Sys().(*syscall.Stat_t)
	if err = f.Chown(int(stat.Uid), int(stat.Gid)); err != nil {
		return err
	}
	if err = f.Chmod(info.Mode().Perm()); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), m.path(p))
}
func (m *Runtime) verifyUninstallSafe(ctx context.Context) error {
	locked, err := m.locked(ctx)
	if err != nil {
		return err
	}
	if !locked {
		return errors.New("guest lock unconfirmed")
	}
	active, err := m.sessions(ctx)
	if err != nil {
		return err
	}
	if active {
		return errors.New("guest session remains")
	}
	if err = m.absent(ctx); err != nil {
		return err
	}
	_, err = m.cmd(ctx, "mountpoint", "--quiet", m.path("/home/guest"))
	if err == nil {
		return errors.New("guest home remains mounted")
	}
	if exitCode(err) != 1 && exitCode(err) != 32 {
		return err
	}
	for _, p := range []string{"/run/labgate/pam-session", "/var/lib/labgate/recovery-needed"} {
		if _, err = os.Lstat(m.path(p)); !os.IsNotExist(err) {
			return fmt.Errorf("local safety marker remains or cannot be checked: %s", p)
		}
	}
	return nil
}
