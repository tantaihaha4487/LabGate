package cli

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"labgate/internal/config"
	"labgate/internal/store"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func writeKey(path string, b *pem.Block) error {
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	return pem.Encode(f, b)
}
func SetupClient() error {
	old, _ := LoadConnection()
	v, e := Ask("Connect to LabGate", []Field{{Label: "Server address", Value: old.Origin}})
	if e != nil || v == nil {
		return e
	}
	if !config.Origin(v[0]) {
		return errors.New("Enter a canonical server origin, such as https://labgate.example.edu")
	}
	if !strings.HasPrefix(v[0], "https://") && v[0] != "http://localhost:3000" && !strings.HasPrefix(v[0], "http://127.0.0.1:") {
		return errors.New("Remote admin connections require HTTPS")
	}
	token := old.Token
	if old.Origin != v[0] {
		token = ""
	}
	return SaveConnection(Connection{v[0], token})
}

var serverAsk = Ask

func SetupServer(path string) error {
	c, e := config.Load(path)
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	fresh := os.IsNotExist(e)
	if fresh {
		c = config.Defaults()
		c.Database = "/var/lib/labgate-server/labgate.db"
		c.KeyPath = filepath.Join(filepath.Dir(path), "provisioner_key")
	}
	v, e := serverAsk("LabGate server setup — database migration is separate", []Field{{"Public server origin", c.Origin, false}, {"Listen address", c.Listen, false}, {"Google client ID", c.GoogleID, false}, {"Google client secret", c.GoogleSecret, true}, {"Administrator emails (comma-separated)", strings.Join(c.Admins, ","), false}, {"SQLite database path", c.Database, false}, {"Guest password length", strconv.Itoa(c.PasswordLength), false}, {"Login grace period (minutes)", fmt.Sprint(c.TTLMinutes), false}, {"Institutional email domain", c.Domain, false}})
	if e != nil || v == nil {
		return e
	}
	c.Domain = v[8]
	c.Origin = v[0]
	c.Listen = v[1]
	c.GoogleID = v[2]
	c.GoogleSecret = v[3]
	c.Admins = nil
	for _, email := range strings.Split(v[4], ",") {
		c.Admins = append(c.Admins, strings.ToLower(strings.TrimSpace(email)))
	}
	c.Database = v[5]
	c.PasswordLength, e = strconv.Atoi(v[6])
	if e != nil {
		return e
	}
	c.TTLMinutes, e = strconv.ParseFloat(v[7], 64)
	if e != nil {
		return e
	}
	if fresh {
		c.RegistrationSecret = store.Random(32)
		c.CronSecret = store.Random(32)
		if e = os.MkdirAll(filepath.Dir(c.KeyPath), 0700); e != nil {
			return e
		}
		if _, e = os.Lstat(c.KeyPath); os.IsNotExist(e) {
			_, key, e := ed25519.GenerateKey(rand.Reader)
			if e != nil {
				return e
			}
			block, e := ssh.MarshalPrivateKey(key, "")
			if e != nil {
				return e
			}
			if e = writeKey(c.KeyPath, block); e != nil {
				return e
			}
		}
	}
	if raw, err := os.ReadFile(c.KeyPath); err == nil {
		if signer, err := ssh.ParsePrivateKey(raw); err == nil {
			if err = os.WriteFile(c.KeyPath+".pub", ssh.MarshalAuthorizedKey(signer.PublicKey()), 0644); err != nil {
				return err
			}
		}
	}
	if e = c.Validate(); e != nil {
		return e
	}
	if e = config.Save(path, c); e != nil {
		return e
	}
	if s, e := store.Open(c.Database); e == nil {
		s.Close()
		fmt.Println("Configuration saved. Database is ready.")
	} else {
		fmt.Printf("Configuration saved. Prepare the database separately:\n  labgate-migrate --config %s\n", path)
	}
	return nil
}
