package cli

import (
	"labgate/internal/config"
	"os"
	"path/filepath"
	"testing"
)

func TestFirstAndRepeatedSetupNeverPrepareDatabase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "server.json")
	db := filepath.Join(dir, "missing.db")
	old := serverAsk
	t.Cleanup(func() { serverAsk = old })
	serverAsk = func(_ string, fields []Field) ([]string, error) {
		return []string{"http://localhost:3000", "127.0.0.1:3000", "fixture-client", "fixture-secret", "admin@ubu.ac.th", db, "8", "3", "ubu.ac.th"}, nil
	}
	if err := SetupServer(path); err != nil {
		t.Fatal(err)
	}
	first, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	key, err := os.ReadFile(first.KeyPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetupServer(path); err != nil {
		t.Fatal(err)
	}
	again, _ := config.Load(path)
	keyAgain, _ := os.ReadFile(again.KeyPath)
	if again.RegistrationSecret != first.RegistrationSecret || again.CronSecret != first.CronSecret || string(keyAgain) != string(key) {
		t.Fatal("repeat setup changed enrollment material")
	}
	for _, p := range []string{db, db + ".lock", db + "-wal", db + "-shm"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("setup created database artifact %s", p)
		}
	}
}
