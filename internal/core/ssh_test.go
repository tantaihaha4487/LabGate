package core

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"golang.org/x/crypto/ssh"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeSSHCommandAndPin(t *testing.T) {
	_, host, _ := ed25519.GenerateKey(rand.Reader)
	hostSigner, _ := ssh.NewSignerFromKey(host)
	_, clientKey, _ := ed25519.GenerateKey(rand.Reader)
	block, _ := ssh.MarshalPrivateKey(clientKey, "")
	p := filepath.Join(t.TempDir(), "key")
	if e := os.WriteFile(p, pem.EncodeToMemory(block), 0600); e != nil {
		t.Fatal(e)
	}
	ln, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer ln.Close()
	type call struct{ command, input string }
	calls := make(chan call, 2)
	go func() {
		for {
			conn, e := ln.Accept()
			if e != nil {
				return
			}
			go func() {
				defer conn.Close()
				cfg := &ssh.ServerConfig{PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) { return nil, nil }}
				cfg.AddHostKey(hostSigner)
				_, channels, requests, e := ssh.NewServerConn(conn, cfg)
				if e != nil {
					return
				}
				go ssh.DiscardRequests(requests)
				for ch := range channels {
					channel, reqs, e := ch.Accept()
					if e != nil {
						return
					}
					go func() {
						defer channel.Close()
						for req := range reqs {
							if req.Type != "exec" {
								req.Reply(false, nil)
								continue
							}
							var msg struct{ Command string }
							ssh.Unmarshal(req.Payload, &msg)
							req.Reply(true, nil)
							input, _ := io.ReadAll(channel)
							calls <- call{msg.Command, string(input)}
							channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{0}))
							return
						}
					}()
				}
			}()
		}
	}()
	dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, ln.Addr().String())
	}
	transport := SSH{KeyPath: p, DialContext: dial}
	pin := ssh.FingerprintSHA256(hostSigner.PublicKey())
	m := Machine{IP: "100.64.0.1", Pin: &pin}
	id := "credential_abcdefghijklmnop"
	password := "abcdEF23"
	if e = transport.Issue(context.Background(), m, id, time.Now().Add(time.Minute).Unix(), password); e != nil {
		t.Fatal(e)
	}
	select {
	case c := <-calls:
		if strings.Contains(c.command, password) || c.input != password+"\n" || !strings.HasPrefix(c.command, "sudo /usr/local/sbin/guest-account.sh issue "+id+" ") {
			t.Fatal("invalid command/stdin framing")
		}
	case <-time.After(time.Second):
		t.Fatal("SSH server did not receive command")
	}
	bad := "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	m.Pin = &bad
	if e = transport.Revoke(context.Background(), m, id); e == nil {
		t.Fatal("host key mismatch accepted")
	}
}
