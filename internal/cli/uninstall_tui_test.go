package cli

import (
	tea "charm.land/bubbletea/v2"
	"strings"
	"testing"
)

func uninstallKey(m uninstallModel, code rune, text string) uninstallModel {
	v, _ := m.Update(tea.KeyPressMsg(tea.Key{Code: code, Text: text}))
	return v.(uninstallModel)
}
func TestUninstallTUIRequiresExactConfirmation(t *testing.T) {
	m := newUninstallModel([]installedRole{{"server", "/etc/systemd/system/labgate.service"}}, "")
	if !m.Confirming || !strings.Contains(m.View().Content, "Retain server account") {
		t.Fatal("missing role or removal plan")
	}
	m = uninstallKey(m, tea.KeyEnter, "")
	if m.Approved {
		t.Fatal("empty Enter approved removal")
	}
	for _, c := range "uninstall" {
		m = uninstallKey(m, c, string(c))
	}
	if m.Approved {
		t.Fatal("typing alone approved removal")
	}
	m = uninstallKey(m, tea.KeyEnter, "")
	if !m.Approved {
		t.Fatal("exact confirmation did not approve")
	}
}
func TestUninstallTUIMixedRolesAndCancellation(t *testing.T) {
	roles := []installedRole{{"server", "/etc/systemd/system/labgate.service"}, {"machine", "/etc/systemd/system/guest-boot-lock.service"}}
	m := newUninstallModel(roles, "")
	if m.Confirming {
		t.Fatal("skipped mixed-role selection")
	}
	m = uninstallKey(m, tea.KeyDown, "")
	m = uninstallKey(m, tea.KeyEnter, "")
	if !m.Confirming || m.Roles[m.Index].name != "machine" || !strings.Contains(m.View().Content, "Retain guest/provisioner") {
		t.Fatal("selected wrong removal plan")
	}
	v, _ := m.Update(tea.WindowSizeMsg{Width: 40, Height: 24})
	m = v.(uninstallModel)
	if !m.View().AltScreen || m.Width != 40 {
		t.Fatal("TUI resize failed")
	}
	m = uninstallKey(m, tea.KeyEscape, "")
	if m.Approved {
		t.Fatal("escape approved removal")
	}
	m = newUninstallModel(roles, "machine")
	if !m.Confirming || m.Index != 1 {
		t.Fatal("explicit role not selected")
	}
}
