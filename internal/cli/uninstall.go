package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"labgate/internal/machine"
	"os"
	"path/filepath"
	"time"
)

func Uninstall(args []string, input io.Reader, out io.Writer) error {
	return uninstall("/", args, input, out)
}

func uninstall(root string, args []string, input io.Reader, out io.Writer) error {
	return uninstallWithPrompt(root, args, out, func(roles []installedRole, selected string) (string, bool, error) {
		return runUninstallTUI(roles, selected, input, out)
	})
}

type uninstallPrompt func([]installedRole, string) (string, bool, error)

func uninstallWithPrompt(root string, args []string, out io.Writer, prompt uninstallPrompt) error {
	f := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	f.SetOutput(out)
	role := f.String("role", "", "select a detected role when this host has multiple roles")
	confirmed := f.Bool("confirm", false, "confirm removal without prompting")
	dry := f.Bool("dry-run", false, "show removal plan without changing files or services")
	if err := f.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if f.NArg() != 0 {
		return errors.New("use --role server, client, or machine")
	}
	if *role != "" && *role != "server" && *role != "client" && *role != "machine" {
		return errors.New("choose server, client, or machine")
	}
	roles, err := detectUninstallRoles(root)
	if err != nil {
		return err
	}
	if len(roles) == 0 {
		return errors.New("no installed LabGate role detected on this host")
	}
	if *role != "" {
		found := false
		for _, detected := range roles {
			if detected.name == *role {
				found = true
			}
		}
		if !found {
			return fmt.Errorf("requested role %q is not installed on this host", *role)
		}
	}
	if !*dry && !*confirmed {
		selected, approved, err := prompt(roles, *role)
		if err != nil {
			return err
		}
		if !approved {
			fmt.Fprintln(out, "Cancelled.")
			return nil
		}
		*role = selected
	} else {
		fmt.Fprintln(out, "Detected LabGate installation:")
		for _, detected := range roles {
			fmt.Fprintf(out, "  %s (%s)\n", detected.name, detected.evidence)
		}
		if *role == "" {
			if len(roles) != 1 {
				return errors.New("multiple installed roles detected; select one with --role server or --role machine")
			}
			*role = roles[0].name
		}
	}
	fmt.Fprintln(out, "Uninstall target:", *role)
	fmt.Fprintln(out, uninstallPlan(*role))
	if *dry {
		return nil
	}
	if os.Geteuid() != 0 {
		return errors.New("run sudo labgate uninstall (or sudo ./labgate uninstall from a release)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	runner := machine.ExecRunner{}
	if *role == "machine" {
		return machine.New(root, runner).Uninstall(ctx, out)
	}
	if err := uninstallLocal(ctx, root, *role, runner); err != nil {
		return err
	}
	fmt.Fprintln(out, "LabGate", *role, "uninstalled. Saved data and configuration retained.")
	return nil
}

// uninstallLocal removes only artifacts owned by the release installer.
func uninstallLocal(ctx context.Context, root, role string, runner machine.Runner) error {
	path := func(p string) string { return filepath.Join(root, p) }
	remove := func(p string) error {
		err := os.Remove(path(p))
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if role == "client" {
		if _, err := os.Lstat(path("/etc/systemd/system/labgate.service")); !os.IsNotExist(err) {
			return errors.New("local server unit exists or cannot be checked; use --role server")
		}
		return remove("/usr/local/bin/labgate")
	}
	if role != "server" {
		return errors.New("invalid uninstall role")
	}
	systemctl := "/usr/bin/systemctl"
	if _, err := os.Stat(systemctl); os.IsNotExist(err) {
		systemctl = "/bin/systemctl"
	}
	if _, err := os.Lstat(path("/etc/systemd/system/labgate.service")); err == nil {
		if _, err = runner.Command(ctx, "", systemctl, "disable", "--now", "labgate.service"); err != nil {
			return fmt.Errorf("stop server: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	for _, p := range []string{"/etc/systemd/system/labgate.service", "/etc/sysusers.d/labgate-server.conf"} {
		if err := remove(p); err != nil {
			return err
		}
	}
	if _, err := runner.Command(ctx, "", systemctl, "daemon-reload"); err != nil {
		return err
	}
	for _, p := range []string{"/usr/local/bin/labgate-migrate", "/usr/local/bin/labgate"} {
		if err := remove(p); err != nil {
			return err
		}
	}
	return nil
}

// Use installed service/helper artifacts, not retained databases or configuration.
// The shared labgate binary alone identifies a client only when no other role exists.
type installedRole struct{ name, evidence string }

func detectUninstallRoles(root string) ([]installedRole, error) {
	var roles []installedRole
	for _, candidate := range []struct {
		name    string
		markers []string
	}{
		{"server", []string{"/etc/systemd/system/labgate.service", "/etc/sysusers.d/labgate-server.conf", "/usr/local/bin/labgate-migrate"}},
		{"machine", []string{"/etc/systemd/system/guest-boot-lock.service", "/usr/local/sbin/guest-session-hook.sh"}},
	} {
		for _, marker := range candidate.markers {
			_, err := os.Lstat(filepath.Join(root, marker))
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return nil, fmt.Errorf("cannot inspect %s; run with sudo: %w", marker, err)
			}
			roles = append(roles, installedRole{candidate.name, marker})
			break
		}
	}
	if len(roles) == 0 {
		marker := "/usr/local/bin/labgate"
		_, err := os.Lstat(filepath.Join(root, marker))
		if err == nil {
			roles = append(roles, installedRole{"client", marker})
		} else if !os.IsNotExist(err) {
			return nil, fmt.Errorf("cannot inspect %s: %w", marker, err)
		}
	}
	return roles, nil
}

func uninstallPlan(role string) string {
	switch role {
	case "server":
		return "Stop and disable labgate.service; remove its unit, sysusers definition, labgate and labgate-migrate binaries. Retain server account, database, configuration, and keys."
	case "client":
		return "Remove /usr/local/bin/labgate. Retain saved client connections and sessions. Refuse removal if a local server unit is installed."
	case "machine":
		return "Require a drained guest session; stop lifecycle timers/services, run Go boot cleanup, back up PAM files, and remove LabGate session hooks. Retain guest/provisioner accounts, SSH restrictions, account-change guards, boot lock, helpers, configuration, and state."
	}
	return ""
}
