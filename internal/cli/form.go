package cli

import (
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"strings"
)

type Field struct {
	Label, Value string
	Secret       bool
}
type Form struct {
	Title           string
	Fields          []Field
	Inputs          []textinput.Model
	Index           int
	Done, Cancelled bool
}

func NewForm(title string, fields []Field) Form {
	f := Form{Title: title, Fields: fields}
	for _, field := range fields {
		v := textinput.New()
		v.SetValue(field.Value)
		v.SetWidth(62)
		v.CharLimit = 2048
		if field.Secret {
			v.EchoMode = textinput.EchoPassword
		}
		f.Inputs = append(f.Inputs, v)
	}
	if len(f.Inputs) > 0 {
		f.Inputs[0].Focus()
	}
	return f
}
func (f Form) Init() tea.Cmd { return textinput.Blink }
func (f Form) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if k, ok := msg.(tea.KeyPressMsg); ok {
		switch k.String() {
		case "ctrl+c", "esc":
			f.Cancelled = true
			return f, tea.Quit
		case "enter":
			if f.Index == len(f.Inputs)-1 {
				f.Done = true
				return f, tea.Quit
			}
			fallthrough
		case "tab", "down":
			f.Inputs[f.Index].Blur()
			f.Index = (f.Index + 1) % len(f.Inputs)
			return f, f.Inputs[f.Index].Focus()
		case "shift+tab", "up":
			f.Inputs[f.Index].Blur()
			f.Index = (f.Index + len(f.Inputs) - 1) % len(f.Inputs)
			return f, f.Inputs[f.Index].Focus()
		}
	}
	var cmd tea.Cmd
	f.Inputs[f.Index], cmd = f.Inputs[f.Index].Update(msg)
	return f, cmd
}
func (f Form) View() tea.View {
	var b strings.Builder
	b.WriteString("\n  " + f.Title + "\n\n")
	for i, field := range f.Fields {
		b.WriteString("  " + field.Label + "\n  " + f.Inputs[i].View() + "\n\n")
	}
	b.WriteString("  Enter: next/save · Tab: next · Esc: cancel\n")
	return tea.NewView(b.String())
}
func Ask(title string, fields []Field) ([]string, error) {
	m, e := tea.NewProgram(NewForm(title, fields)).Run()
	if e != nil {
		return nil, e
	}
	f := m.(Form)
	if f.Cancelled {
		return nil, nil
	}
	var out []string
	for _, v := range f.Inputs {
		out = append(out, v.Value())
	}
	return out, nil
}
