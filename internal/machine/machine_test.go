package machine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testID = "credential_abcdefghijklmnop"

func TestPasswordAndDispatcher(t *testing.T) {
	for _, v := range []string{"abcdEF23\nextra", "abcdEF23", "abcdEF23\n\n", "abcdE$23\n"} {
		if _, e := ReadPassword(strings.NewReader(v)); e == nil {
			t.Fatalf("accepted malformed password %q", v)
		}
	}
	base := "sudo /usr/local/sbin/guest-account.sh issue " + testID + " 1800000300"
	args, p, e := Dispatch(base, strings.NewReader("abcdEF23\n"))
	if e != nil || len(args) != 5 || p != "abcdEF23\n" {
		t.Fatal(args, e)
	}
	for _, v := range []string{" " + base, base + " ", strings.Replace(base, "sudo ", "sudo  ", 1), base + ";id", base + "\n", strings.Replace(base, "guest-account.sh", "bash", 1), "sudo /usr/local/sbin/guest-account.sh revoke x"} {
		if _, _, e = Dispatch(v, strings.NewReader("abcdEF23\n")); e == nil {
			t.Fatal("unsafe dispatcher input accepted")
		}
	}
}
func TestStateAndPAMContext(t *testing.T) {
	s, e := ParseState(testID + "\t1800000300\tpending\t1\t1800000000")
	if e != nil || s.State != "pending" {
		t.Fatal(s, e)
	}
	for _, v := range []string{testID + "\t1800000300\tactive\t1\t1800000000", testID + "\t1800000300\trevoked\t3\tbad", testID + "\t1800000300\tpending\t1\t1800000000\textra"} {
		if _, e = ParseState(v); e == nil {
			t.Fatal("corrupt state accepted")
		}
	}
	env := func(k string) string { return map[string]string{"PAM_SERVICE": "gdm-password", "PAM_USER": "guest"}[k] }
	if ContextKey(42, env) == ContextKey(43, env) {
		t.Fatal("PAM parent identity lost")
	}
}

type fakeRunner struct {
	commands      []string
	fail          string
	locked        bool
	sessionActive bool
	root          string
}

func (f *fakeRunner) Command(_ context.Context, input, name string, args ...string) (string, error) {
	f.commands = append(f.commands, name+" "+strings.Join(args, " "))
	if strings.Contains(name+" "+strings.Join(args, " "), f.fail) && f.fail != "" {
		return "", errors.New("injected failure")
	}
	switch filepath.Base(name) {
	case "id":
		return "1001", nil
	case "passwd":
		if len(args) > 0 && args[0] == "-S" {
			if f.locked {
				return "guest L 2026-10-02 0 99999 7 -1", nil
			}
			return "guest P 2026-10-02 0 99999 7 -1", nil
		}
		if len(args) > 0 && args[0] == "-l" {
			f.locked = true
		}
		if len(args) > 0 && args[0] == "-u" {
			f.locked = false
		}
	case "loginctl":
		if len(args) > 0 && args[0] == "terminate-user" {
			f.sessionActive = false
		}
		if len(args) > 0 && args[0] == "list-sessions" && f.sessionActive {
			return "1 1001 guest seat0 tty1", nil
		}
		return "", nil
	case "rm":
		target := args[len(args)-1]
		if f.root != "" && strings.HasPrefix(target, f.root+"/") {
			return "", os.RemoveAll(target)
		}
	case "mountpoint":
		return "", fakeExit32{}
	case "pgrep":
		return "", fakeExit1{}
	case "keyctl":
		if args[0] == "get_persistent" {
			return "123", nil
		}
		if args[0] == "list" {
			return "keyring is empty", nil
		}
	case "getent":
		return "guest:!:1:0::0:::", nil
	}
	return "", nil
}

// File tests run as root only inside the disposable acceptance containers.
func TestRootStateQueueCompatibility(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root-owned file acceptance runs in disposable containers")
	}
	root := t.TempDir()
	m := New(root, &fakeRunner{})
	m.Now = func() time.Time { return time.Unix(1800000000, 0) }
	s := State{ID: testID, Deadline: 1800000300, State: "pending"}
	if e := m.writeState(s); e != nil {
		t.Fatal(e)
	}
	s.State = "revoked"
	if e := m.writeState(s); e != nil {
		t.Fatal(e)
	}
	tomb, e := os.ReadFile(m.path("/var/lib/labgate/tombstones/" + testID))
	if e != nil || string(tomb) != "1800000000\n" {
		t.Fatal(string(tomb), e)
	}
	if e = m.Queue("session-close", testID, 3); e != nil {
		t.Fatal(e)
	}
	v, e := os.ReadFile(m.path("/var/lib/labgate/outbox/event-v2-000000000000000001"))
	if e != nil || string(v) != fmt.Sprintf("session-close\t%s\t3\n", testID) {
		t.Fatal(string(v), e)
	}
	if e = os.Symlink("/etc/passwd", m.path("/var/lib/labgate/outbox/event-v2-000000000000000002")); e != nil {
		t.Fatal(e)
	}
	if _, e = m.read("/var/lib/labgate/outbox/event-v2-000000000000000002", true); e == nil {
		t.Fatal("symlink event accepted")
	}
}

type fakeExit32 struct{}

func (fakeExit32) Error() string { return "not mounted" }

type fakeExit1 struct{}

func (fakeExit1) Error() string { return "absent" }

func (fakeExit32) ExitCode() int { return 32 }
func (fakeExit1) ExitCode() int  { return 1 }

type passwordRunner struct{ *fakeRunner }

func (r passwordRunner) Command(ctx context.Context, input, name string, args ...string) (string, error) {
	switch filepath.Base(name) {
	case "id", "passwd", "chage", "chpasswd", "getent":
		return (ExecRunner{}).Command(ctx, input, name, args...)
	default:
		return r.fakeRunner.Command(ctx, input, name, args...)
	}
}

func TestContainerRealPasswordUtilities(t *testing.T) {
	if os.Geteuid() != 0 || os.Getenv("LABGATE_CONTAINER_PASSWORD_TEST") != "1" {
		t.Skip("only enabled in disposable distro containers with a test guest account")
	}
	root := t.TempDir()
	m := New(root, passwordRunner{&fakeRunner{root: root}})
	for _, p := range []string{"/home", "/tmp", "/var/tmp", "/dev/shm", "/run/user"} {
		if err := os.MkdirAll(m.path(p), 0755); err != nil {
			t.Fatal(err)
		}
	}
	for p, v := range map[string]string{"/etc/labgate/password-length": "8\n", "/etc/labgate/guest-home-mode": "y\n", "/etc/labgate/auth-failure-backends": "none\n"} {
		if err := m.atomic(p, v); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	if err := m.Account(ctx, []string{"issue", testID, fmt.Sprint(time.Now().Add(3 * time.Minute).Unix())}, strings.NewReader("abcdEF23\n")); err != nil {
		t.Fatal(err)
	}
	locked, err := m.locked(ctx)
	if err != nil || locked {
		t.Fatal("real passwd did not confirm unlocked account")
	}
	if err = m.Account(ctx, []string{"revoke", testID}, strings.NewReader("")); err != nil {
		t.Fatal(err)
	}
	locked, err = m.locked(ctx)
	if err != nil || !locked {
		t.Fatal("real passwd did not confirm locked account")
	}
}

func TestRootLifecycleAndFailSecure(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("privileged filesystem acceptance runs in disposable containers")
	}
	root := t.TempDir()
	if e := os.MkdirAll(filepath.Join(root, "run/lock"), 0755); e != nil {
		t.Fatal(e)
	}
	if e := os.Chmod(filepath.Join(root, "run/lock"), 0777|os.ModeSticky); e != nil {
		t.Fatal(e)
	}
	runner := &fakeRunner{root: root, locked: true}
	m := New(root, runner)
	now := int64(1800000000)
	m.Now = func() time.Time { return time.Unix(now, 0) }
	for _, p := range []string{"/home", "/tmp", "/var/tmp", "/dev/shm", "/run/user"} {
		if e := os.MkdirAll(m.path(p), 0755); e != nil {
			t.Fatal(e)
		}
	}
	for path, value := range map[string]string{"/etc/labgate/password-length": "8\n", "/etc/labgate/guest-home-mode": "y\n", "/etc/labgate/auth-failure-backends": "none\n"} {
		if e := m.atomic(path, value); e != nil {
			t.Fatal(e)
		}
	}
	ctx := context.Background()
	if e := m.Account(ctx, []string{"issue", testID, "1800000180"}, strings.NewReader("abcdEF23\n")); e != nil {
		t.Fatal(e)
	}
	if runner.locked {
		t.Fatal("issue did not unlock")
	}
	env := func(k string) string {
		return map[string]string{"PAM_USER": "guest", "PAM_TYPE": "open_session", "PAM_SERVICE": "gdm-password"}[k]
	}
	if e := m.PAM(ctx, env, 42); e != nil {
		t.Fatal(e)
	}
	runner.sessionActive = true
	now += 1000
	if e := m.Cleanup(ctx, false); e != nil {
		t.Fatal(e)
	}
	s, _ := m.State()
	if s.State != "active" {
		t.Fatal("active session expired")
	}
	if e := m.Account(ctx, []string{"revoke", testID}, strings.NewReader("")); e == nil {
		t.Fatal("active revoke accepted")
	}
	closeEnv := func(k string) string {
		if k == "PAM_TYPE" {
			return "close_session"
		}
		return env(k)
	}
	if e := m.PAM(ctx, closeEnv, 43); e != nil {
		t.Fatal(e)
	}
	s, _ = m.State()
	if s.State != "active" {
		t.Fatal("unmatched close terminated active session")
	}
	if e := m.PAM(ctx, closeEnv, 42); e != nil {
		t.Fatal(e)
	}
	s, _ = m.State()
	if s.State != "revoked" || !runner.locked {
		t.Fatal("matching close did not secure")
	}
	if e := m.Account(ctx, []string{"issue", testID, fmt.Sprint(now + 180)}, strings.NewReader("abcdEF23\n")); e == nil {
		t.Fatal("terminal generation reused")
	}
	id := "credential_second_generation_123"
	runner.fail = "chage"
	if e := m.Account(ctx, []string{"issue", id, fmt.Sprint(now + 180)}, strings.NewReader("abcdEF23\n")); e == nil {
		t.Fatal("authentication reset failure accepted")
	}
	if !runner.locked {
		t.Fatal("failed issue left guest unlocked")
	}
	for _, cmd := range runner.commands {
		if strings.Contains(cmd, "abcdEF23") || strings.Contains(cmd, "curl") || strings.Contains(cmd, "wget") {
			t.Fatal("secret argument or PAM network command")
		}
	}
}

type findRunner struct{ *fakeRunner }

func (r findRunner) Command(ctx context.Context, input, name string, args ...string) (string, error) {
	if filepath.Base(name) == "find" {
		r.fakeRunner.Command(ctx, input, name, args...)
		return (ExecRunner{}).Command(ctx, input, name, args...)
	}
	return r.fakeRunner.Command(ctx, input, name, args...)
}

func TestRootCrashDumpsDoNotOutliveGuestSession(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root-owned fixture runs in disposable containers")
	}
	root := t.TempDir()
	m := New(root, findRunner{&fakeRunner{root: root, locked: true}})
	for _, p := range []string{"/run/user", "/var/lib/systemd/coredump", "/var/crash", "/var/log/journal/0123456789abcdef0123456789abcdef"} {
		if e := os.MkdirAll(m.path(p), 0755); e != nil {
			t.Fatal(e)
		}
	}
	boot := "0123456789abcdef0123456789abcdef"
	journal := "/var/log/journal/" + boot
	guest := []string{"/var/lib/systemd/coredump/core.firefox.1001." + boot + ".4242.1792000000000000.zst", "/var/crash/_usr_bin_python3.1001.crash", journal + "/user-1001.journal", journal + "/user-1001@0000000000000001-0000000000000002.journal"}
	others := []string{"/var/lib/systemd/coredump/core.firefox.1000." + boot + ".4243.1792000000000000.zst", journal + "/user-10010.journal", journal + "/system.journal"}
	for _, p := range append(guest, others...) {
		if e := os.WriteFile(m.path(p), []byte("memory"), 0640); e != nil {
			t.Fatal(e)
		}
	}
	// A matching directory must not make every later reset fail.
	if e := os.MkdirAll(m.path("/var/crash/evil.1001.crash/nested"), 0755); e != nil {
		t.Fatal(e)
	}
	if e := m.external(context.Background()); e != nil && strings.Contains(e.Error(), "crash") {
		t.Fatal("crash sweep failed on a directory entry", e)
	}
	for _, p := range guest {
		if _, e := os.Lstat(m.path(p)); !os.IsNotExist(e) {
			t.Fatal("guest crash dump survived cleanup", p)
		}
	}
	for _, p := range others {
		if _, e := os.Lstat(m.path(p)); e != nil {
			t.Fatal("another user's data was removed", p, e)
		}
	}
}
