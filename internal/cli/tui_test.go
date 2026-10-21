package cli

import (
	tea "charm.land/bubbletea/v2"
	"fmt"
	"labgate/internal/core"
	"strings"
	"testing"
)

func key(v string) tea.KeyPressMsg {
	switch v {
	case "tab":
		return tea.KeyPressMsg(tea.Key{Code: tea.KeyTab})
	case "esc":
		return tea.KeyPressMsg(tea.Key{Code: tea.KeyEscape})
	}
	return tea.KeyPressMsg(tea.Key{Code: rune(v[0]), Text: v})
}

func TestActivityScrollingReachesEveryEntry(t *testing.T) {
	m := NewModel(NewClient(Connection{Origin: "https://labgate.example", Token: "test-token"}))
	m.Tab = 1
	m.Height = 18
	for i := 0; i < 50; i++ {
		m.Activity.Entries = append(m.Activity.Entries, core.Activity{Email: fmt.Sprintf("student-%02d@ubu.ac.th", i), Source: "web", Status: "reserved"})
	}
	for i := 0; i < 45; i++ {
		v, _ := m.Update(key("j"))
		m = v.(Model)
	}
	if m.Selected != 45 || !strings.Contains(m.View().Content, "student-45@ubu.ac.th") || strings.Contains(m.View().Content, "student-00@ubu.ac.th") {
		t.Fatal("activity entries are inaccessible after resizing")
	}
}
func TestTUIVisibilityConfirmationAndResize(t *testing.T) {
	m := NewModel(NewClient(Connection{Origin: "https://labgate.example", Token: "test-token"}))
	m.Machines = []core.Machine{{ID: "test", Name: "Desktop", Status: "available"}}
	v, _ := m.Update(key("h"))
	m = v.(Model)
	if m.Confirm == nil {
		t.Fatal("missing confirmation")
	}
	v, _ = m.Update(key("esc"))
	m = v.(Model)
	if m.Confirm != nil {
		t.Fatal("cancel did not clear confirmation")
	}
	v, _ = m.Update(tea.WindowSizeMsg{Width: 40, Height: 12})
	m = v.(Model)
	if m.Width != 40 || !strings.Contains(m.View().Content, "LabGate") {
		t.Fatal("resize broke view")
	}
	v, _ = m.Update(key("tab"))
	if v.(Model).Tab != 1 {
		t.Fatal("tab navigation failed")
	}
}
func TestTerminalControlCharactersRemoved(t *testing.T) {
	if strings.Contains(clean("x\x1b[31m\ny"), "\x1b") {
		t.Fatal("terminal injection")
	}
}
