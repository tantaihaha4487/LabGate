package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

type Config struct {
	Origin             string   `json:"origin"`
	Listen             string   `json:"listen"`
	Database           string   `json:"database"`
	KeyPath            string   `json:"provisionerKey"`
	GoogleID           string   `json:"googleClientId"`
	GoogleSecret       string   `json:"googleClientSecret"`
	Domain             string   `json:"allowedEmailDomain"`
	Admins             []string `json:"adminEmails"`
	RegistrationSecret string   `json:"registrationSecret"`
	CronSecret         string   `json:"cronSecret"`
	PasswordLength     int      `json:"passwordLength"`
	TTLMinutes         float64  `json:"credentialTTLMinutes"`
}

func Defaults() Config {
	return Config{Origin: "http://localhost:3000", Listen: "127.0.0.1:3000", Database: "data/labgate.db", KeyPath: "secrets/provisioner_key", Domain: "ubu.ac.th", PasswordLength: 8, TTLMinutes: 3}
}
func Path() string {
	if p := os.Getenv("LABGATE_CONFIG"); p != "" {
		return p
	}
	return "/etc/labgate/server.json"
}
func Load(path string) (Config, error) {
	c := Defaults()
	b, e := os.ReadFile(path)
	if e != nil {
		return c, e
	}
	e = json.Unmarshal(b, &c)
	return c, e
}
func Save(path string, v any) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".labgate-config-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0600); e != nil {
		f.Close()
		return e
	}
	if old, e := os.Stat(path); e == nil && os.Geteuid() == 0 {
		if stat, ok := old.Sys().(*syscall.Stat_t); ok {
			if e = f.Chown(int(stat.Uid), int(stat.Gid)); e != nil {
				f.Close()
				return e
			}
		}
	}
	if _, e = f.Write(append(b, '\n')); e != nil {
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
	return os.Rename(f.Name(), path)
}
func (c Config) TTL() time.Duration { return time.Duration(c.TTLMinutes * float64(time.Minute)) }
func (c Config) Allowed(email string) bool {
	return strings.HasSuffix(strings.ToLower(email), "@"+c.Domain) && strings.Count(email, "@") == 1
}
func (c Config) Admin(email string) bool {
	if !c.Allowed(email) {
		return false
	}
	for _, a := range c.Admins {
		if strings.EqualFold(a, email) {
			return true
		}
	}
	return false
}

var bearer = regexp.MustCompile(`^[A-Za-z0-9._~+/-]+={0,}$`)

func ValidBearer(v string) bool { return len(v) >= 20 && len(v) <= 256 && bearer.MatchString(v) }
func Origin(v string) bool {
	u, e := url.Parse(v)
	if e != nil || !strings.HasPrefix(v, "http://") && !strings.HasPrefix(v, "https://") || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(v, " ?#\t\r\n") || strings.Contains(u.Host, "[") {
		return false
	}
	if u.Port() != "" {
		var port int
		if _, e := fmt.Sscanf(u.Port(), "%d", &port); e != nil || port < 1 || port > 65535 || fmt.Sprint(port) != u.Port() {
			return false
		}
	}
	h := u.Hostname()
	if ip, e := netip.ParseAddr(h); e == nil {
		return ip.Is4() && ip.String() == h
	}
	if len(h) > 253 || regexp.MustCompile(`^[0-9.]+$`).MatchString(h) {
		return false
	}
	for _, label := range strings.Split(h, ".") {
		if len(label) > 63 || !regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`).MatchString(label) {
			return false
		}
	}
	return true
}
func (c Config) Validate() error {
	if !Origin(c.Origin) {
		return errors.New("origin must be a canonical http(s) origin without a path")
	}
	if c.GoogleID == "" || c.GoogleSecret == "" {
		return errors.New("Google client ID and secret are required")
	}
	if c.Domain == "" || c.Domain != strings.ToLower(c.Domain) || strings.ContainsAny(c.Domain, "@ /\t\n") {
		return errors.New("invalid allowed email domain")
	}
	if len(c.Admins) == 0 {
		return errors.New("at least one administrator is required")
	}
	for _, a := range c.Admins {
		if !c.Allowed(a) {
			return errors.New("administrators must belong to the allowed domain")
		}
	}
	if !ValidBearer(c.RegistrationSecret) || !ValidBearer(c.CronSecret) {
		return errors.New("registration and cron secrets must be 20–256 character bearer tokens")
	}
	if c.PasswordLength < 5 || c.PasswordLength > 128 || !(c.TTLMinutes >= 1 && c.TTLMinutes <= 1440) {
		return errors.New("password length must be 5–128 and login grace must be 1–1440 minutes")
	}
	if !filepath.IsAbs(c.KeyPath) {
		return errors.New("provisioner key path must be absolute")
	}
	s, e := os.Lstat(c.KeyPath)
	if e != nil || !s.Mode().IsRegular() || s.Size() == 0 || s.Mode().Perm() != 0600 {
		return errors.New("provisioner key must be a nonempty regular file with mode 0600")
	}
	raw, err := os.ReadFile(c.KeyPath)
	if err != nil {
		return errors.New("provisioner key is not readable")
	}
	if _, err = ssh.ParsePrivateKey(raw); err != nil {
		return errors.New("provisioner key must be a usable unencrypted SSH private key")
	}
	return nil
}
