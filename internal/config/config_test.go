package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOriginAndBearer(t *testing.T) {
	for _, v := range []string{"http://localhost:3000", "https://labgate.example.edu", "http://100.64.0.1:3000"} {
		if !Origin(v) {
			t.Fatal(v)
		}
	}
	for _, v := range []string{"https://x/", "https://x/a", "https://user@x", "https://x?secret=a", "HTTP://x", "https://[::1]", "https://x:00080", "https://x:65536", "https://x #a"} {
		if Origin(v) {
			t.Fatal("invalid origin accepted", v)
		}
	}
	if !ValidBearer("abcdefghijklmnopqrstu+/==") || ValidBearer("abcdefghijklmnopqrst\n") {
		t.Fatal("bearer validation")
	}
}
func TestConfigurationAtomicRepeatSave(t *testing.T) {
	p := filepath.Join(t.TempDir(), "server.json")
	if e := Save(p, Defaults()); e != nil {
		t.Fatal(e)
	}
	c := Defaults()
	c.Listen = "127.0.0.1:4000"
	if e := Save(p, c); e != nil {
		t.Fatal(e)
	}
	v, e := Load(p)
	if e != nil || v.Listen != c.Listen {
		t.Fatal(v, e)
	}
	info, _ := os.Stat(p)
	if info.Mode().Perm() != 0600 {
		t.Fatal("configuration is not private")
	}
}
