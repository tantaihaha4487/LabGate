package cli

import (
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"context"
	"fmt"
	"labgate/internal/config"
	"labgate/internal/core"
	"labgate/internal/store"
	"net/url"
	"strings"
	"time"
)

type tick time.Time
type response struct {
	Kind   string
	Tab    int
	Value  any
	Err    error
	Status int
}
type pairing struct {
	ID   string `json:"id"`
	Code string `json:"code"`
	URL  string `json:"verificationUrl"`
}
type pending struct {
	Path, Method string
	Body         any
	Description  string
}
type Model struct {
	Client                       *Client
	Tab, Selected, Width, Height int
	Machines                     []core.Machine
	Activity                     core.ActivityPage
	Admins                       []string
	Error, Notice                string
	Busy                         bool
	Cursor                       string
	Previous                     []string
	Source, Action, Email        string
	Pair                         pairing
	PairSecret                   string
	PairDeadline                 time.Time
	Form                         *Form
	FormKind                     string
	Confirm                      *pending
	Secret                       string
	SecretLabel                  string
	Quit                         bool
}

func NewModel(c *Client) Model {
	return Model{Client: c, Width: 100, Height: 30, Source: "all", Action: "all"}
}
func timer() tea.Cmd { return tea.Tick(2*time.Second, func(t time.Time) tea.Msg { return tick(t) }) }
func (m Model) Init() tea.Cmd {
	if m.Client.Token == "" {
		return tea.Batch(m.startLogin(), timer())
	}
	return tea.Batch(m.refresh(), timer())
}
func (m Model) request(kind, method, path string, b, out any) tea.Cmd {
	tab := m.Tab
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		status, e := m.Client.Request(ctx, method, path, b, out)
		return response{kind, tab, out, e, status}
	}
}
func (m Model) startLogin() tea.Cmd {
	m.Client.Token = ""
	secret := store.Random(32)
	return func() tea.Msg {
		v := pairing{}
		_, e := m.Client.Request(context.Background(), "POST", "/api/cli/start", map[string]string{"secret": secret}, &v)
		return response{Kind: "pair", Value: struct {
			Pair   pairing
			Secret string
		}{v, secret}, Err: e}
	}
}
func (m Model) refresh() tea.Cmd {
	if m.Tab == 1 {
		v := &core.ActivityPage{}
		p := url.Values{"source": {m.Source}, "action": {m.Action}}
		if m.Email != "" {
			p.Set("email", m.Email)
		}
		if m.Cursor != "" {
			p.Set("cursor", m.Cursor)
		}
		return m.request("activity", "GET", "/api/admin/logs?"+p.Encode(), nil, v)
	}
	v := &struct {
		Machines []core.Machine `json:"machines"`
		Admins   []string       `json:"adminEmails"`
	}{}
	return m.request("machines", "GET", "/api/admin/machines", nil, v)
}
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.WindowSizeMsg:
		m.Width = v.Width
		m.Height = v.Height
		return m, nil
	case tick:
		cmd := timer()
		if m.Busy || m.Form != nil || m.Confirm != nil || m.Secret != "" {
			return m, cmd
		}
		if m.Pair.ID != "" {
			if time.Now().After(m.PairDeadline) {
				m.Pair = pairing{}
				m.Error = "Login expired. Press r to retry."
				return m, cmd
			}
			if int(time.Now().Unix())%3 != 0 {
				return m, cmd
			}
			out := &struct {
				Token string `json:"token"`
			}{}
			m.Busy = true
			return m, tea.Batch(cmd, m.request("poll", "POST", "/api/cli/poll", map[string]string{"id": m.Pair.ID, "secret": m.PairSecret}, out))
		}
		if m.Client.Token == "" || m.Tab == 1 && m.Cursor != "" {
			return m, cmd
		}
		m.Busy = true
		return m, tea.Batch(cmd, m.refresh())
	case response:
		m.Busy = false
		if v.Err != nil {
			m.Error = v.Err.Error()
			if v.Status == 401 {
				m.Client.Token = ""
				m.Pair = pairing{}
				m.Error = "Session expired. Press r to sign in."
			}
			return m, nil
		}
		m.Error = ""
		switch v.Kind {
		case "pair":
			p := v.Value.(struct {
				Pair   pairing
				Secret string
			})
			m.Pair = p.Pair
			m.PairSecret = p.Secret
			m.PairDeadline = time.Now().Add(5 * time.Minute)
		case "poll":
			p := v.Value.(*struct {
				Token string `json:"token"`
			})
			if p.Token != "" {
				m.Client.Token = p.Token
				m.Pair = pairing{}
				m.PairSecret = ""
				if e := SaveConnection(m.Client.Connection); e != nil {
					m.Error = "Login succeeded but credentials could not be saved."
				}
				m.Busy = true
				return m, m.refresh()
			}
		case "machines":
			p := v.Value.(*struct {
				Machines []core.Machine `json:"machines"`
				Admins   []string       `json:"adminEmails"`
			})
			if v.Tab == m.Tab {
				selectedID := ""
				if m.Selected >= 0 && m.Selected < len(m.Machines) {
					selectedID = m.Machines[m.Selected].ID
				}
				m.Machines = p.Machines
				for i, machine := range m.Machines {
					if machine.ID == selectedID {
						m.Selected = i
						break
					}
				}
				m.Admins = p.Admins
				if m.Selected >= len(m.Machines) {
					m.Selected = max(0, len(m.Machines)-1)
				}
			}
		case "activity":
			if v.Tab == m.Tab {
				m.Activity = *v.Value.(*core.ActivityPage)
			}
		case "mutation":
			m.Notice = "Updated."
			m.Busy = true
			return m, m.refresh()
		case "enroll":
			p := v.Value.(*map[string]any)
			m.Secret, _ = (*p)["webhookToken"].(string)
			m.SecretLabel = "Enrollment token — install root-only on the machine; press Esc to dismiss"
		case "logout":
			m.Client.Token = ""
			SaveConnection(m.Client.Connection)
			m.Pair = pairing{}
			m.Busy = true
			return m, m.startLogin()
		}
		return m, nil
	case tea.KeyPressMsg:
		k := v.String()
		if k == "ctrl+c" {
			return m, tea.Quit
		}
		if m.Secret != "" {
			if k == "esc" || k == "enter" {
				m.Secret = ""
			}
			return m, nil
		}
		if m.Confirm != nil {
			if k == "esc" || k == "n" {
				m.Confirm = nil
				return m, nil
			}
			if k == "y" && !m.Busy {
				p := m.Confirm
				m.Confirm = nil
				m.Busy = true
				kind := "mutation"
				var out any = &map[string]any{}
				if strings.Contains(p.Path, "register-machine") {
					kind = "enroll"
				}
				return m, m.request(kind, p.Method, p.Path, p.Body, out)
			}
			return m, nil
		}
		if m.Form != nil {
			if k == "esc" {
				m.Form = nil
				return m, nil
			}
			if k == "enter" && m.Form.Index == len(m.Form.Inputs)-1 {
				return m.submit()
			}
			updated, cmd := m.Form.Update(msg)
			f := updated.(Form)
			m.Form = &f
			return m, cmd
		}
		if k == "q" {
			return m, tea.Quit
		}
		if m.Busy {
			return m, nil
		}
		if m.Client.Token == "" {
			if k == "r" {
				m.Busy = true
				m.Busy = true
				return m, m.startLogin()
			}
			return m, nil
		}
		switch k {
		case "tab", "right":
			m.Tab = (m.Tab + 1) % 4
			m.Selected = 0
			m.Busy = true
			return m, m.refresh()
		case "shift+tab", "left":
			m.Tab = (m.Tab + 3) % 4
			m.Selected = 0
			m.Busy = true
			return m, m.refresh()
		case "j", "down":
			count := len(m.Machines)
			if m.Tab == 1 {
				count = len(m.Activity.Entries)
			}
			m.Selected = max(0, min(count-1, m.Selected+1))
		case "k", "up":
			m.Selected = max(0, m.Selected-1)
		case "r":
			m.Busy = true
			m.Busy = true
			return m, m.refresh()
		case "esc":
			m.Notice = ""
		case "enter":
			if (m.Tab == 0 || m.Tab == 2) && len(m.Machines) > 0 {
				x := m.Machines[m.Selected]
				value := func(p *string) string {
					if p == nil {
						return "none"
					}
					return clean(*p)
				}
				m.Notice = fmt.Sprintf("%s · %s\nMachine ID: %s\nHost key: %s\nLast heartbeat: %s\nSafety hold: %s", clean(x.Name), clean(x.IP), clean(x.ID), value(x.Pin), value(x.Heartbeat), value(x.Hold))
				if r := x.Reservation; r != nil {
					m.Notice += fmt.Sprintf("\nReservation: %s · %s · %s\nCreated: %s\nLogin deadline: %s\nOpened: %s\nState version: %d", clean(r.ID), clean(r.Email), clean(r.State), clean(r.Created), clean(r.Expires), value(r.Opened), r.Version)
				}
			}
		case "h":
			if m.Tab == 0 && len(m.Machines) > 0 {
				x := m.Machines[m.Selected]
				m.Confirm = &pending{Path: "/api/admin/machines/" + x.ID + "/visibility", Method: "PATCH", Body: map[string]bool{"hidden": !x.Hidden}, Description: "Change student visibility for " + clean(x.Name) + "?"}
			}
		case "n":
			if m.Tab == 1 && m.Activity.Cursor != nil {
				m.Selected = 0
				m.Previous = append(m.Previous, m.Cursor)
				m.Cursor = *m.Activity.Cursor
				m.Busy = true
				return m, m.refresh()
			}
		case "p":
			if m.Tab == 1 && len(m.Previous) > 0 {
				m.Selected = 0
				m.Cursor = m.Previous[len(m.Previous)-1]
				m.Previous = m.Previous[:len(m.Previous)-1]
				m.Busy = true
				return m, m.refresh()
			}
		case "f":
			if m.Tab == 1 {
				f := NewForm("Activity filters", []Field{{"Source: all / web / physical", m.Source, false}, {"Action: all / checkout / login / logout / timeout", m.Action, false}, {"Exact email (optional)", m.Email, false}})
				m.Form = &f
				m.FormKind = "filter"
			}
		case "e":
			f := NewForm("Enroll machine", []Field{{Label: "Machine name"}, {Label: "Tailscale IPv4"}, {Label: "Ed25519 SHA256 host-key fingerprint"}})
			m.Form = &f
			m.FormKind = "enroll"
		case "x":
			if (m.Tab == 0 || m.Tab == 2) && len(m.Machines) > 0 {
				x := m.Machines[m.Selected]
				f := NewForm("Rekey drained machine", []Field{{"Machine name", x.Name, false}, {"Tailscale IPv4", x.IP, false}, {"Replacement SHA256 fingerprint", func() string {
					if x.Pin != nil {
						return *x.Pin
					}
					return ""
				}(), false}})
				m.Form = &f
				m.FormKind = "rekey"
			}
		case "a":
			f := NewForm("Generate administrator configuration", []Field{{"Institutional administrator emails (comma-separated)", strings.Join(m.Admins, ","), false}})
			m.Form = &f
			m.FormKind = "admins"
		case "c":
			f := NewForm("Connection settings", []Field{{"Server HTTPS origin", m.Client.Origin, false}})
			m.Form = &f
			m.FormKind = "connection"
		case "l":
			m.Busy = true
			return m, m.request("logout", "POST", "/api/auth/sign-out", map[string]any{}, &map[string]any{})
		}
		return m, nil
	}
	return m, nil
}
func (m Model) submit() (tea.Model, tea.Cmd) {
	var values []string
	for _, v := range m.Form.Inputs {
		values = append(values, v.Value())
	}
	m.Form = nil
	switch m.FormKind {
	case "filter":
		m.Selected = 0
		m.Source = values[0]
		m.Action = values[1]
		m.Email = values[2]
		m.Cursor = ""
		m.Previous = nil
		m.Busy = true
		return m, m.refresh()
	case "connection":
		if !strings.HasPrefix(values[0], "https://") && values[0] != "http://localhost:3000" && !strings.HasPrefix(values[0], "http://127.0.0.1:") {
			m.Error = "Remote connections require HTTPS"
			return m, nil
		}
		if !config.Origin(values[0]) {
			m.Error = "Invalid server origin"
			return m, nil
		}
		m.Client.Origin = values[0]
		m.Client.Token = ""
		if e := SaveConnection(m.Client.Connection); e != nil {
			m.Error = e.Error()
			return m, nil
		}
		m.Busy = true
		return m, m.startLogin()
	case "admins":
		emails := strings.Split(values[0], ",")
		for i, e := range emails {
			emails[i] = strings.ToLower(strings.TrimSpace(e))
			if !strings.Contains(emails[i], "@") || strings.ContainsAny(emails[i], "\n\r\"'") {
				m.Error = "Invalid email list"
				return m, nil
			}
		}
		m.Notice = "ADMIN_EMAILS=" + strings.Join(emails, ",") + "\nUpdate the server configuration using server setup; this screen does not change permissions."
		return m, nil
	case "enroll", "rekey":
		v := core.Identity{Name: values[0], IP: values[1], Pin: values[2]}
		method := "POST"
		if m.FormKind == "rekey" {
			if len(m.Machines) == 0 {
				return m, nil
			}
			x := m.Machines[m.Selected]
			v.MachineID = x.ID
			v.ExpectedName = x.Name
			v.ExpectedIP = x.IP
			v.ExpectedPin = x.Pin
			method = "PATCH"
		}
		m.Confirm = &pending{Path: "/api/admin/register-machine", Method: method, Body: v, Description: "Confirm " + m.FormKind + " for " + clean(v.Name) + "?"}
	}
	return m, nil
}
func clean(v string) string {
	return strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, v)
}
func (m Model) View() tea.View {
	title := lipgloss.NewStyle().Bold(true).Render("LabGate")
	var b strings.Builder
	b.WriteString(title + "  " + clean(m.Client.Origin) + "\n\n")
	if m.Pair.ID != "" {
		b.WriteString("Sign in to the website as an administrator, then open:\n" + m.Pair.URL + "\n\nPairing code: " + m.Pair.Code + "\nApprove only the code shown in this terminal.\nWaiting for approval…\n")
	} else if m.Secret != "" {
		b.WriteString(m.SecretLabel + "\n\n" + m.Secret + "\n")
	} else if m.Form != nil {
		b.WriteString(m.Form.View().Content)
	} else {
		tabs := []string{"Machines", "Activity", "Enrollment / Rekey", "Administrators"}
		for i, t := range tabs {
			if i == m.Tab {
				t = "[" + t + "]"
			}
			b.WriteString(t + "  ")
		}
		b.WriteString("\n\n")
		switch m.Tab {
		case 0, 2:
			if len(m.Machines) == 0 {
				b.WriteString("No machines enrolled yet. Press e to enroll.\n")
			}
			start := max(0, m.Selected-max(1, m.Height-13)/2)
			end := min(len(m.Machines), start+max(1, m.Height-13))
			for i := start; i < end; i++ {
				x := m.Machines[i]
				mark := "  "
				if i == m.Selected {
					mark = "> "
				}
				visible := "visible"
				if x.Hidden {
					visible = "hidden"
				}
				hold := ""
				if x.Hold != nil {
					hold = " · SAFETY HOLD"
				}
				reservation := ""
				if x.Reservation != nil {
					reservation = " · " + clean(x.Reservation.Email) + " · " + x.Reservation.State
				}
				b.WriteString(fmt.Sprintf("%s%-22s %-10s %-8s %s%s%s\n", mark, clean(x.Name), x.Status, x.Connectivity, visible, hold, reservation))
			}
			if m.Tab == 2 {
				b.WriteString("\ne: enroll · x: rekey selected drained machine\nInstall a lab machine using the release installer, role: machine.\n")
			}
		case 1:
			b.WriteString("Source: " + m.Source + " · Action: " + m.Action + " · Email: " + clean(m.Email) + "\n\n")
			if len(m.Activity.Entries) == 0 {
				b.WriteString("No matching activity.\n")
			}
			start := max(0, m.Selected-max(1, m.Height-13)/2)
			end := min(len(m.Activity.Entries), start+max(1, m.Height-13))
			for i := start; i < end; i++ {
				v := m.Activity.Entries[i]
				mark := "  "
				if i == m.Selected {
					mark = "> "
				}
				machine := ""
				if info, ok := v.Machine.(map[string]any); ok {
					if name, ok := info["name"].(string); ok {
						machine = " · " + clean(name)
					}
				}
				b.WriteString(mark + v.Occurred + "  " + v.Source + "  " + v.Status + "  " + clean(v.Email) + machine + "\n")
			}

			b.WriteString("\nf: filters · n: older · p: newer\n")
		case 3:
			for _, a := range m.Admins {
				b.WriteString(clean(a) + "\n")
			}
			b.WriteString("\na: generate administrator configuration\n")
		}
	}
	if m.Confirm != nil {
		b.WriteString("\n" + m.Confirm.Description + "  y: confirm · n/Esc: cancel\n")
	}
	if m.Error != "" {
		b.WriteString("\nError: " + clean(m.Error) + "\n")
	}
	if m.Notice != "" {
		b.WriteString("\n" + m.Notice + "\n")
	}
	b.WriteString("\nTab: screens · Enter: details · ↑/↓: select · h: hide/restore · r: retry/refresh · c: connection · l: logout · q: quit")
	v := tea.NewView(lipgloss.NewStyle().Width(max(20, m.Width-4)).Padding(1, 2).Render(b.String()))
	v.AltScreen = true
	return v
}
func Run(c *Client) error { m := NewModel(c); m.Busy = true; _, e := tea.NewProgram(m).Run(); return e }
