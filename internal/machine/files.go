// Package machine implements the local, privileged physical guest lifecycle.
package machine

import (
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var idRE = regexp.MustCompile(`^[A-Za-z0-9_-]{20,64}$`)
var passwordRE = regexp.MustCompile(`^[A-HJ-NP-Za-km-z2-9]{5,128}$`)
var sequenceRE = regexp.MustCompile(`^event-v2-([0-9]{18})$`)

const maxSequence int64 = 999999999999999999

type State struct {
	ID       string
	Deadline int64
	State    string
	Version  int
	Changed  int64
}
type Runtime struct {
	Root string
	Run  Runner
	Now  func() time.Time
}

func New(root string, runner Runner) *Runtime {
	return &Runtime{Root: root, Run: runner, Now: time.Now}
}
func (m *Runtime) path(v string) string { return filepath.Join(m.Root, v) }
func version(s string) int {
	switch s {
	case "pending":
		return 1
	case "active":
		return 2
	case "revoked":
		return 3
	}
	return 0
}
func (m *Runtime) trusted(path string, private bool) error {
	p := m.path(path)
	for cur := p; cur != m.Root && cur != "/"; cur = filepath.Dir(cur) {
		s, e := os.Lstat(cur)
		if e != nil {
			return e
		}
		var stat unix.Stat_t
		if e = unix.Lstat(cur, &stat); e != nil {
			return e
		}
		u := stat.Uid
		if s.Mode()&os.ModeSymlink != 0 || u != 0 || s.Mode().Perm()&0022 != 0 && !(cur == m.path("/run/lock") && s.Mode()&os.ModeSticky != 0) {
			return errors.New("path is not root controlled")
		}
		if cur == p && (!s.Mode().IsRegular() || private && s.Mode().Perm() != 0600) {
			return errors.New("invalid file permissions")
		}
	}
	return nil
}
func (m *Runtime) read(p string, private bool) (string, error) {
	if e := m.trusted(p, private); e != nil {
		return "", e
	}
	fd, e := unix.Open(m.path(p), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if e != nil {
		return "", e
	}
	f := os.NewFile(uintptr(fd), p)
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 4097))
	if e != nil || len(b) > 4096 {
		return "", errors.New("invalid configuration/state file")
	}
	if !strings.HasSuffix(string(b), "\n") || strings.Count(string(b), "\n") != 1 {
		return "", errors.New("expected exactly one newline-terminated record")
	}
	return strings.TrimSuffix(string(b), "\n"), nil
}
func (m *Runtime) dirs() error {
	for _, p := range []string{"/etc/labgate", "/var/lib/labgate", "/var/lib/labgate/outbox", "/var/lib/labgate/tombstones", "/run/labgate", "/run/lock/labgate"} {
		full := m.path(p)
		for ancestor := full; ancestor != m.Root && ancestor != "/"; ancestor = filepath.Dir(ancestor) {
			info, err := os.Lstat(ancestor)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return err
			}
			var stat unix.Stat_t
			if err = unix.Lstat(ancestor, &stat); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != 0 || info.Mode().Perm()&0022 != 0 && !(ancestor == m.path("/run/lock") && info.Mode()&os.ModeSticky != 0) {
				return errors.New("unsafe lifecycle directory ancestor")
			}
		}
		if e := os.MkdirAll(full, 0700); e != nil {
			return e
		}
		s, e := os.Lstat(full)
		if e != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
			return errors.New("unsafe lifecycle directory")
		}
		var st unix.Stat_t
		if e = unix.Lstat(full, &st); e != nil || st.Uid != 0 || s.Mode().Perm()&0022 != 0 {
			return errors.New("unsafe lifecycle directory ownership")
		}
	}
	return nil
}
func (m *Runtime) atomic(path, v string) error {
	if e := m.dirs(); e != nil {
		return e
	}
	dir := filepath.Dir(m.path(path))
	f, e := os.CreateTemp(dir, ".labgate-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0600); e != nil {
		f.Close()
		return e
	}
	if _, e = f.WriteString(v); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = os.Rename(f.Name(), m.path(path)); e != nil {
		return e
	}
	d, e := os.Open(dir)
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func (m *Runtime) lock(name string, nonblock bool) (*os.File, error) {
	if e := m.dirs(); e != nil {
		return nil, e
	}
	path := "/run/lock/labgate/" + name
	fd, e := unix.Open(m.path(path), unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), path)
	if e = m.trusted(path, true); e != nil {
		f.Close()
		return nil, e
	}
	deadline := time.Now().Add(25 * time.Second)
	for {
		e = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if e == nil {
			return f, nil
		}
		if nonblock || time.Now().After(deadline) {
			f.Close()
			return nil, e
		}
		time.Sleep(25 * time.Millisecond)
	}
}
func ParseState(v string) (State, error) {
	f := strings.Split(v, "\t")
	if len(f) != 5 || !idRE.MatchString(f[0]) {
		return State{}, errors.New("corrupt credential state")
	}
	deadline, e := strconv.ParseInt(f[1], 10, 64)
	if e != nil || deadline <= 0 || len(f[1]) > 12 || !regexpDigits(f[1]) {
		return State{}, errors.New("invalid deadline")
	}
	changed, e := strconv.ParseInt(f[4], 10, 64)
	ver, ve := strconv.Atoi(f[3])
	if e != nil || ve != nil || changed <= 0 || len(f[4]) > 12 || !regexpDigits(f[4]) || strconv.Itoa(ver) != f[3] || ver != version(f[2]) || ver == 0 {
		return State{}, errors.New("invalid lifecycle version")
	}
	return State{f[0], deadline, f[2], ver, changed}, nil
}
func (m *Runtime) State() (State, error) {
	v, e := m.read("/var/lib/labgate/credential-state", false)
	if e != nil {
		return State{}, e
	}
	return ParseState(v)
}
func (m *Runtime) tombstone(id string) error {
	if !idRE.MatchString(id) {
		return errors.New("invalid generation")
	}
	path := "/var/lib/labgate/tombstones/" + id
	v, e := m.read(path, false)
	if e == nil {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			return errors.New("corrupt tombstone")
		}
		return nil
	}
	if !os.IsNotExist(e) {
		return e
	}
	return m.atomic(path, fmt.Sprintln(m.Now().Unix()))
}
func (m *Runtime) writeState(s State) error {
	if !idRE.MatchString(s.ID) || version(s.State) == 0 {
		return errors.New("invalid state")
	}
	old, e := m.State()
	if e == nil && old.ID != s.ID {
		if old.State != "revoked" {
			return errors.New("another generation is live")
		}
		if e = m.tombstone(old.ID); e != nil {
			return e
		}
	} else if e != nil && !os.IsNotExist(e) {
		return e
	}
	if s.State == "revoked" {
		if e = m.tombstone(s.ID); e != nil {
			return e
		}
	}
	s.Version = version(s.State)
	s.Changed = m.Now().Unix()
	return m.atomic("/var/lib/labgate/credential-state", fmt.Sprintf("%s\t%d\t%s\t%d\t%d\n", s.ID, s.Deadline, s.State, s.Version, s.Changed))
}
func (m *Runtime) recovery(reason, id string) {
	if !idRE.MatchString(id) {
		id = "-"
	}
	m.atomic("/var/lib/labgate/recovery-needed", fmt.Sprintf("%d\t%s\t%s\n", m.Now().Unix(), id, reason))
}
func (m *Runtime) clear(p string) error {
	e := os.Remove(m.path(p))
	if os.IsNotExist(e) {
		return nil
	}
	return e
}
func (m *Runtime) Queue(endpoint, id string, ver int) error {
	if !idRE.MatchString(id) || (endpoint == "session-open" && ver != 2) || (endpoint == "session-close" || endpoint == "credential-expired") && ver != 3 || endpoint != "session-open" && endpoint != "session-close" && endpoint != "credential-expired" {
		return errors.New("invalid event")
	}
	l, e := m.lock("outbox-sequence.lock", false)
	if e != nil {
		return e
	}
	defer l.Close()
	seq := int64(0)
	v, e := m.read("/var/lib/labgate/outbox-sequence", true)
	if e == nil {
		seq, e = strconv.ParseInt(v, 10, 64)
		if e != nil || seq < 0 || seq > maxSequence || strconv.FormatInt(seq, 10) != v {
			return errors.New("corrupt sequence")
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	entries, e := os.ReadDir(m.path("/var/lib/labgate/outbox"))
	if e != nil {
		return e
	}
	for _, v := range entries {
		if strings.HasPrefix(v.Name(), ".") {
			continue
		}
		parts := sequenceRE.FindStringSubmatch(v.Name())
		if parts == nil {
			return errors.New("legacy/unknown outbox entry requires drained operator migration")
		}
		n, _ := strconv.ParseInt(parts[1], 10, 64)
		if n <= 0 {
			return errors.New("invalid outbox sequence")
		}
		if n > seq {
			seq = n
		}
	}
	if seq >= maxSequence {
		return errors.New("sequence exhausted")
	}
	seq++
	if e = m.atomic("/var/lib/labgate/outbox-sequence", fmt.Sprintln(seq)); e != nil {
		return e
	}
	return m.atomic(fmt.Sprintf("/var/lib/labgate/outbox/event-v2-%018d", seq), fmt.Sprintf("%s\t%s\t%d\n", endpoint, id, ver))
}
