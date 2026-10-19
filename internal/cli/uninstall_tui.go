package cli

import (
	"fmt"
	"io"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

type uninstallModel struct {
	Roles                []installedRole
	Index, Width         int
	Confirming, Approved bool
	Input                textinput.Model
}

func newUninstallModel(roles []installedRole, selected string) uninstallModel {
	input := textinput.New()
	input.Placeholder = "uninstall"
	input.CharLimit = 32
	input.SetWidth(30)
	m := uninstallModel{Roles: roles, Width: 80, Input: input, Confirming: selected != "" || len(roles) == 1}
	for i, role := range roles {
		if role.name == selected {
			m.Index = i
		}
	}
	if m.Confirming {
		m.Input.Focus()
	}
	return m
}
func (m uninstallModel) Init() tea.Cmd {
	if m.Confirming {
		return textinput.Blink
	}
	return nil
}
func (m uninstallModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.Width = msg.Width
		m.Input.SetWidth(max(10, min(30, msg.Width-6)))
	case tea.KeyPressMsg:
		switch msg.String() {
		case "ctrl+c", "esc":
			return m, tea.Quit
		case "enter":
			if !m.Confirming {
				m.Confirming = true
				return m, m.Input.Focus()
			}
			if m.Input.Value() == "uninstall" {
				m.Approved = true
				return m, tea.Quit
			}
			return m, nil
		}
		if !m.Confirming {
			switch msg.String() {
			case "down", "j", "tab":
				m.Index = (m.Index + 1) % len(m.Roles)
			case "up", "k", "shift+tab":
				m.Index = (m.Index + len(m.Roles) - 1) % len(m.Roles)
			}
			return m, nil
		}
	}
	if m.Confirming {
		var cmd tea.Cmd
		m.Input, cmd = m.Input.Update(msg)
		return m, cmd
	}
	return m, nil
}
func (m uninstallModel) View() tea.View {
	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Bold(true).Render("LabGate uninstall") + "\n\nDetected on this host:\n")
	for i, role := range m.Roles {
		prefix := "  "
		if i == m.Index {
			prefix = "> "
		}
		fmt.Fprintf(&b, "%s%s\n    %s\n", prefix, role.name, role.evidence)
	}
	role := m.Roles[m.Index].name
	fmt.Fprintf(&b, "\nRemoval plan for %s:\n%s\n\n", role, uninstallPlan(role))
	if m.Confirming {
		b.WriteString("Type " + lipgloss.NewStyle().Bold(true).Render("uninstall") + " to confirm removal:\n" + m.Input.View() + "\n\nEnter: confirm · Esc: cancel")
	} else {
		b.WriteString("↑/↓: choose installed role · Enter: review confirmation · Esc: cancel")
	}
	v := tea.NewView(lipgloss.NewStyle().Width(max(10, m.Width-4)).Padding(1, 2).Render(b.String()))
	v.AltScreen = true
	return v
}
func runUninstallTUI(roles []installedRole, selected string, input io.Reader, out io.Writer) (string, bool, error) {
	result, err := tea.NewProgram(newUninstallModel(roles, selected), tea.WithInput(input), tea.WithOutput(out)).Run()
	if err != nil {
		return "", false, err
	}
	m := result.(uninstallModel)
	return m.Roles[m.Index].name, m.Approved, nil
}
