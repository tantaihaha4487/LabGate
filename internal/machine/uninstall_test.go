package machine

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUninstallPAMFiltering(t *testing.T) {
	original := "auth required pam_unix.so\n# keep this\n"
	for line := range sessionHooks {
		original += line + "\n"
	}
	original += "session optional pam_systemd.so\nsession required pam_exec.so /custom/hook"
	expected := "auth required pam_unix.so\n# keep this\nsession optional pam_systemd.so\nsession required pam_exec.so /custom/hook"
	if got := string(stripHooks([]byte(original))); got != expected {
		t.Fatalf("PAM changed incorrectly: %q", got)
	}
}
func TestRootMachineUninstall(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root-owned fixture runs in disposable containers")
	}
	root := t.TempDir()
	r := &fakeRunner{root: root}
	m := New(root, r)
	for _, p := range []string{"/etc/pam.d", "/etc/labgate", "/home", "/tmp", "/var/tmp", "/dev/shm", "/run/user", "/root"} {
		if err := os.MkdirAll(m.path(p), 0755); err != nil {
			t.Fatal(err)
		}
	}
	fixtures := map[string]string{
		"/etc/labgate/pam-file": "/etc/pam.d/login\n",
		"/etc/pam.d/login":      "auth required pam_unix.so\nsession required pam_exec.so quiet type=open_session /usr/local/sbin/guest-session-hook.sh\n",
		"/etc/pam.d/chfn":       "auth requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh\n",
		"/etc/pam.d/chsh":       "auth requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh\n",
		"/etc/pam.d/passwd":     "password requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh\n",
	}
	for p, b := range fixtures {
		if err := os.WriteFile(m.path(p), []byte(b), 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Occupied endpoints must not be modified or have their session killed.
	r.sessionActive = true
	if err := m.Uninstall(context.Background(), &bytes.Buffer{}); err == nil {
		t.Fatal("accepted active session")
	}
	if len(r.commands) != 2 {
		t.Fatal("mutated occupied endpoint", r.commands)
	}
	r.sessionActive = false
	var out bytes.Buffer
	if err := m.Uninstall(context.Background(), &out); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(m.path("/etc/pam.d/login"))
	if err != nil || string(b) != "auth required pam_unix.so\n" {
		t.Fatal(string(b), err)
	}
	backups, err := filepath.Glob(m.path("/root/labgate-uninstall-*/etc/pam.d/login"))
	if err != nil || len(backups) != 1 {
		t.Fatal(backups, err)
	}
	b, err = os.ReadFile(backups[0])
	if err != nil || string(b) != fixtures["/etc/pam.d/login"] {
		t.Fatal("backup differs", err)
	}
	for _, p := range []string{"chfn", "chsh", "passwd"} {
		b, err = os.ReadFile(m.path("/etc/pam.d/" + p))
		if err != nil || string(b) != fixtures["/etc/pam.d/"+p] {
			t.Fatal("guard changed", p, err)
		}
	}
	if !r.locked || !strings.Contains(out.String(), "integration removed") {
		t.Fatal("safety not verified", out.String())
	}
}
