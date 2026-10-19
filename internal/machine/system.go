package machine

import (
	"context"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Runner interface {
	Command(context.Context, string, string, ...string) (string, error)
}
type ExecRunner struct{}

func (ExecRunner) Command(ctx context.Context, input, name string, args ...string) (string, error) {
	if !filepath.IsAbs(name) {
		return "", errors.New("command must be absolute")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	out, e := cmd.Output()
	if e != nil {
		return "", e
	}
	if len(out) > 1024*1024 {
		return "", errors.New("command output too large")
	}
	return strings.TrimSpace(string(out)), nil
}
func utilityPath(name string) string {
	for _, dir := range []string{"/usr/bin", "/usr/sbin", "/bin", "/sbin"} {
		path := filepath.Join(dir, name)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			return path
		}
	}
	return "/usr/bin/" + name
}
func (m *Runtime) cmd(ctx context.Context, name string, args ...string) (string, error) {
	return m.Run.Command(ctx, "", utilityPath(name), args...)
}
func (m *Runtime) uid(ctx context.Context) (string, error) {
	v, e := m.cmd(ctx, "id", "-u", "guest")
	if e != nil {
		return "", e
	}
	n, e := strconv.Atoi(v)
	if e != nil || n <= 0 {
		return "", errors.New("invalid guest UID")
	}
	return v, nil
}
func (m *Runtime) locked(ctx context.Context) (bool, error) {
	v, e := m.cmd(ctx, "passwd", "-S", "guest")
	if e != nil {
		return false, e
	}
	f := strings.Fields(v)
	if len(f) < 2 || f[0] != "guest" {
		return false, errors.New("unknown account lock state")
	}
	switch f[1] {
	case "L", "LK":
		return true, nil
	case "P", "PS":
		return false, nil
	}
	return false, errors.New("unknown account lock state")
}
func (m *Runtime) sessions(ctx context.Context) (bool, error) {
	uid, e := m.uid(ctx)
	if e != nil {
		return false, e
	}
	v, e := m.cmd(ctx, "loginctl", "list-sessions", "--no-legend", "--no-pager")
	if e != nil {
		return false, e
	}
	for _, line := range strings.Split(v, "\n") {
		f := strings.Fields(line)
		if len(f) > 1 && f[1] == uid {
			return true, nil
		}
	}
	return false, nil
}
func exitCode(e error) int {
	var v interface{ ExitCode() int }
	if errors.As(e, &v) {
		return v.ExitCode()
	}
	return -1
}
func (m *Runtime) absent(ctx context.Context) error {
	uid, e := m.uid(ctx)
	if e != nil {
		return e
	}
	for _, flag := range []string{"-u", "-U"} {
		_, e = m.cmd(ctx, "pgrep", flag, uid)
		if exitCode(e) != 1 {
			return errors.New("guest processes exist or inventory failed")
		}
	}
	return nil
}
func (m *Runtime) kill(ctx context.Context) error {
	uid, e := m.uid(ctx)
	if e != nil {
		return e
	}
	m.cmd(ctx, "loginctl", "terminate-user", "guest")
	for _, sig := range []string{"-TERM", "-KILL"} {
		m.cmd(ctx, "pkill", sig, "-u", uid)
		m.cmd(ctx, "pkill", sig, "-U", uid)
		for i := 0; i < 20; i++ {
			if m.absent(ctx) == nil {
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
	return errors.New("guest processes remain")
}
func safeDir(p string, root bool) error {
	s, e := os.Lstat(p)
	if e != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
		return errors.New("unsafe directory")
	}
	var st unix.Stat_t
	if e = unix.Lstat(p, &st); e != nil {
		return e
	}
	if root && (st.Uid != 0 || s.Mode().Perm()&0022 != 0) {
		return errors.New("unsafe directory ownership")
	}
	return nil
}
func (m *Runtime) unmount(ctx context.Context, p string) error {
	_, e := m.cmd(ctx, "mountpoint", "--quiet", p)
	if e == nil {
		if _, e = m.cmd(ctx, "umount", p); e != nil {
			return e
		}
	} else if exitCode(e) != 32 && exitCode(e) != 1 {
		return errors.New("mount inventory failed")
	}
	_, e = m.cmd(ctx, "mountpoint", "--quiet", p)
	if e == nil {
		return errors.New("mount remains")
	}
	if exitCode(e) != 32 && exitCode(e) != 1 {
		return e
	}
	return nil
}
func (m *Runtime) seal(ctx context.Context) error {
	p := m.path("/home/guest")
	if e := m.unmount(ctx, p); e != nil {
		return e
	}
	if e := safeDir(filepath.Dir(p), true); e != nil {
		return e
	}
	if e := os.MkdirAll(p, 0700); e != nil {
		return e
	}
	if e := safeDir(p, false); e != nil {
		return e
	}
	if e := os.Chown(p, 0, 0); e != nil {
		return e
	}
	return os.Chmod(p, 0700)
}
func (m *Runtime) scratch(ctx context.Context) error {
	if e := m.absent(ctx); e != nil {
		return e
	}
	uid, e := m.uid(ctx)
	if e != nil {
		return e
	}
	paths := []string{"/tmp", "/var/tmp", "/dev/shm", "/dev/mqueue"}
	for _, p := range paths {
		p = m.path(p)
		if _, e := os.Lstat(p); os.IsNotExist(e) && strings.HasSuffix(p, "mqueue") {
			continue
		}
		if e := safeDir(p, false); e != nil {
			return e
		}
		if _, e = m.cmd(ctx, "find", p, "-xdev", "-depth", "-mindepth", "1", "-uid", uid, "-delete"); e != nil {
			return e
		}
		v, e := m.cmd(ctx, "find", p, "-xdev", "-mindepth", "1", "-uid", uid, "-print", "-quit")
		if e != nil || v != "" {
			return errors.New("guest scratch remains")
		}
	}
	return nil
}
func (m *Runtime) external(ctx context.Context) error {
	if e := m.absent(ctx); e != nil {
		return e
	}
	uid, e := m.uid(ctx)
	if e != nil {
		return e
	}
	var failures []error
	parent := m.path("/run/user")
	if e = os.MkdirAll(parent, 0755); e != nil {
		failures = append(failures, e)
	} else if e = safeDir(parent, true); e != nil {
		failures = append(failures, e)
	} else {
		p := filepath.Join(parent, uid)
		if e := m.unmount(ctx, p); e != nil {
			failures = append(failures, e)
		} else {
			_, e = m.cmd(ctx, "rm", "-rf", "--one-file-system", "--", p)
			if e != nil {
				failures = append(failures, e)
			}
		}
	}
	for _, flag := range []string{"q", "m", "s"} {
		inventory, e := m.cmd(ctx, "ipcs", "-"+flag, "-c")
		if e != nil {
			failures = append(failures, e)
			continue
		}
		for _, line := range strings.Split(inventory, "\n") {
			f := strings.Fields(line)
			if len(f) >= 5 && (f[2] == "guest" || f[4] == "guest" || f[2] == uid || f[4] == uid) {
				if n, err := strconv.ParseUint(f[0], 10, 64); err == nil {
					if _, e = m.cmd(ctx, "ipcrm", "-"+flag, strconv.FormatUint(n, 10)); e != nil {
						failures = append(failures, e)
					}
				}
			}
		}
		check, e := m.cmd(ctx, "ipcs", "-"+flag, "-c")
		if e != nil {
			failures = append(failures, e)
		} else {
			for _, line := range strings.Split(check, "\n") {
				f := strings.Fields(line)
				if len(f) >= 5 && (f[2] == "guest" || f[4] == "guest" || f[2] == uid || f[4] == uid) {
					failures = append(failures, errors.New("guest IPC remains"))
				}
			}
		}
	}
	ring, e := m.cmd(ctx, "keyctl", "get_persistent", "@s", uid)
	if e != nil {
		failures = append(failures, e)
	} else if _, e = strconv.ParseUint(ring, 10, 64); e != nil {
		failures = append(failures, e)
	} else {
		if _, e = m.cmd(ctx, "keyctl", "clear", ring); e != nil {
			failures = append(failures, e)
		}
		v, e := m.cmd(ctx, "keyctl", "list", ring)
		if e != nil || v != "keyring is empty" {
			failures = append(failures, errors.New("guest keyring remains"))
		}
		if _, e = m.cmd(ctx, "keyctl", "unlink", ring, "@s"); e != nil {
			failures = append(failures, e)
		}
	}
	for _, p := range []string{"/var/mail", "/var/spool/mail"} {
		p = m.path(p)
		if _, e := os.Lstat(p); os.IsNotExist(e) {
			continue
		}
		canonical, e := filepath.EvalSymlinks(p)
		if e != nil || canonical != m.path("/var/mail") && canonical != m.path("/var/spool/mail") {
			failures = append(failures, errors.New("unsafe mailbox parent"))
			continue
		}
		var st unix.Stat_t
		if e = unix.Lstat(canonical, &st); e != nil || st.Uid != 0 || st.Mode&unix.S_IFMT != unix.S_IFDIR || st.Mode&0002 != 0 && st.Mode&unix.S_ISVTX == 0 {
			failures = append(failures, errors.New("unsafe mailbox permissions"))
			continue
		}
		mail := filepath.Join(canonical, "guest")
		if e = m.unmount(ctx, mail); e != nil {
			failures = append(failures, e)
		} else if _, e = m.cmd(ctx, "rm", "-rf", "--one-file-system", "--", mail); e != nil {
			failures = append(failures, e)
		}
	}
	return errors.Join(failures...)
}
func (m *Runtime) Secure(ctx context.Context) error {
	var failures []error
	check := func(e error) {
		if e != nil {
			failures = append(failures, e)
		}
	}
	_, e := m.cmd(ctx, "passwd", "-l", "guest")
	check(e)
	locked, e := m.locked(ctx)
	check(e)
	if !locked {
		check(errors.New("guest lock unconfirmed"))
	}
	m.cmd(ctx, "loginctl", "disable-linger", "guest")
	check(m.clear("/var/lib/systemd/linger/guest"))
	if _, e = os.Lstat(m.path("/var/lib/systemd/linger/guest")); !os.IsNotExist(e) {
		check(errors.New("guest linger remains"))
	}
	check(m.kill(ctx))
	check(m.external(ctx))
	check(m.scratch(ctx))
	check(m.seal(ctx))
	return errors.Join(failures...)
}
func (m *Runtime) home(ctx context.Context) error {
	uid, e := m.uid(ctx)
	if e != nil {
		return e
	}
	gid, e := m.cmd(ctx, "id", "-g", "guest")
	if e != nil {
		return e
	}
	if _, e = strconv.Atoi(gid); e != nil {
		return e
	}
	mode, e := m.read("/etc/labgate/guest-home-mode", true)
	if e != nil || mode != "n" && mode != "y" {
		return errors.New("invalid home mode")
	}
	if e = m.external(ctx); e != nil {
		return e
	}
	if e = m.scratch(ctx); e != nil {
		return e
	}
	if e = m.seal(ctx); e != nil {
		return e
	}
	home := m.path("/home/guest")
	if mode == "n" {
		if _, e = m.cmd(ctx, "mount", "--types", "tmpfs", "--options", fmt.Sprintf("uid=%s,gid=%s,mode=0700,size=512M,nosuid,nodev", uid, gid), "tmpfs", home); e != nil {
			return e
		}
		fs, e := m.cmd(ctx, "findmnt", "-n", "-o", "FSTYPE", "--target", home)
		if e != nil || fs != "tmpfs" {
			return errors.New("tmpfs verification failed")
		}
	} else {
		u, _ := strconv.Atoi(uid)
		g, _ := strconv.Atoi(gid)
		if e = os.Chown(home, u, g); e != nil {
			return e
		}
		if e = os.Chmod(home, 0700); e != nil {
			return e
		}
	}
	p := filepath.Join(m.path("/run/user"), uid)
	if e = os.Mkdir(p, 0700); e != nil {
		return e
	}
	u, _ := strconv.Atoi(uid)
	g, _ := strconv.Atoi(gid)
	return os.Chown(p, u, g)
}
