package cli

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type uninstallRunner struct {
	fail  bool
	calls []string
}

func (r *uninstallRunner) Command(_ context.Context, _, name string, args ...string) (string, error) {
	r.calls = append(r.calls, name+" "+strings.Join(args, " "))
	if r.fail {
		return "", errors.New("systemctl failed")
	}
	return "", nil
}
func TestUninstallPreviewAndCancellation(t *testing.T) {
	for _, role := range []string{"server", "client", "machine"} {
		root := t.TempDir()
		marker := map[string]string{"server": "/etc/systemd/system/labgate.service", "client": "/usr/local/bin/labgate", "machine": "/etc/systemd/system/guest-boot-lock.service"}[role]
		writeUninstallFixture(t, root, marker)
		var out bytes.Buffer
		if err := uninstall(root, []string{"--dry-run"}, strings.NewReader(""), &out); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), "Uninstall target: "+role) || !strings.Contains(out.String(), "Retain") {
			t.Fatal(out.String())
		}
		out.Reset()
		if err := uninstallWithPrompt(root, nil, &out, func(roles []installedRole, selected string) (string, bool, error) { return "", false, nil }); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), "Cancelled.") {
			t.Fatal(out.String())
		}
		if _, err := os.Stat(filepath.Join(root, marker)); err != nil {
			t.Fatal("changed marker", err)
		}
	}
	if err := Uninstall([]string{"--role", "bad", "--confirm"}, strings.NewReader(""), &bytes.Buffer{}); err == nil {
		t.Fatal("accepted invalid role")
	}
}
func writeUninstallFixture(t *testing.T, root, p string) {
	t.Helper()
	full := filepath.Join(root, p)
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestUninstallDetectionBoundaries(t *testing.T) {
	root := t.TempDir()
	// Retained server config and data do not classify a removed server.
	writeUninstallFixture(t, root, "/etc/labgate/server.json")
	writeUninstallFixture(t, root, "/var/lib/labgate-server/labgate.db")
	if err := uninstall(root, []string{"--confirm"}, strings.NewReader(""), &bytes.Buffer{}); err == nil {
		t.Fatal("accepted uninstalled host")
	}
	writeUninstallFixture(t, root, "/usr/local/bin/labgate")
	if err := uninstall(root, []string{"--role", "server", "--confirm"}, strings.NewReader(""), &bytes.Buffer{}); err == nil {
		t.Fatal("accepted mismatched role")
	}
	writeUninstallFixture(t, root, "/etc/systemd/system/labgate.service")
	writeUninstallFixture(t, root, "/etc/systemd/system/guest-boot-lock.service")
	var out bytes.Buffer
	if err := uninstall(root, []string{"--confirm"}, strings.NewReader(""), &out); err == nil {
		t.Fatal("automatically selected mixed host")
	}
	if !strings.Contains(out.String(), "server (") || !strings.Contains(out.String(), "machine (") || strings.Contains(out.String(), "client (") {
		t.Fatal(out.String())
	}
	if err := uninstall(root, []string{"--role", "machine", "--dry-run"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"/usr/local/bin/labgate", "/etc/systemd/system/labgate.service", "/etc/systemd/system/guest-boot-lock.service"} {
		if _, err := os.Stat(filepath.Join(root, p)); err != nil {
			t.Fatal("detection changed files", err)
		}
	}
}
func TestUninstallServerPreservesDataAndHandlesStopFailure(t *testing.T) {
	root := t.TempDir()
	paths := []string{"/etc/systemd/system/labgate.service", "/etc/sysusers.d/labgate-server.conf", "/usr/local/bin/labgate", "/usr/local/bin/labgate-migrate", "/etc/labgate/server.json", "/var/lib/labgate-server/labgate.db"}
	for _, p := range paths {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("saved"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	r := &uninstallRunner{fail: true}
	if err := uninstallLocal(context.Background(), root, "server", r); err == nil {
		t.Fatal("ignored stop failure")
	}
	for _, p := range paths {
		if _, err := os.Stat(filepath.Join(root, p)); err != nil {
			t.Fatal("removed after failure:", p, err)
		}
	}
	if err := uninstallLocal(context.Background(), root, "client", r); err == nil {
		t.Fatal("client removed server binary")
	}
	r.fail = false
	if err := uninstallLocal(context.Background(), root, "server", r); err != nil {
		t.Fatal(err)
	}
	for _, p := range paths[:4] {
		if _, err := os.Stat(filepath.Join(root, p)); !os.IsNotExist(err) {
			t.Fatal("artifact remains", p, err)
		}
	}
	for _, p := range paths[4:] {
		b, err := os.ReadFile(filepath.Join(root, p))
		if err != nil || string(b) != "saved" {
			t.Fatal("data changed", p, err)
		}
	}
}
