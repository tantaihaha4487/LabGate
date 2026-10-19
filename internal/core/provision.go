package core

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"net"
	"os"
	"strings"
	"time"
)

type Provisioner interface {
	Issue(context.Context, Machine, string, int64, string) error
	Revoke(context.Context, Machine, string) error
}
type SSH struct {
	KeyPath     string
	DialContext func(context.Context, string, string) (net.Conn, error)
}

func (p SSH) Issue(ctx context.Context, m Machine, id string, deadline int64, password string) error {
	if len(password) < 5 || len(password) > 128 || strings.IndexFunc(password, func(r rune) bool {
		return !strings.ContainsRune("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789", r)
	}) >= 0 {
		return errors.New("invalid password")
	}
	now := time.Now().Unix()
	if deadline <= now || deadline > now+86460 {
		return errors.New("invalid deadline")
	}
	return p.run(ctx, m, "sudo /usr/local/sbin/guest-account.sh issue "+id+" "+fmt.Sprint(deadline), password+"\n")
}
func (p SSH) Revoke(ctx context.Context, m Machine, id string) error {
	return p.run(ctx, m, "sudo /usr/local/sbin/guest-account.sh revoke "+id, "")
}
func (p SSH) run(ctx context.Context, m Machine, cmd, input string) error {
	fields := strings.Fields(cmd)
	if len(fields) < 4 || !CredentialID.MatchString(fields[3]) || m.Pin == nil || !ValidPin(*m.Pin) || !ValidIP(m.IP) {
		return errors.New("invalid provisioning target or generation")
	}
	key, e := os.ReadFile(p.KeyPath)
	if e != nil {
		return errors.New("cannot read provisioning key")
	}
	signer, e := ssh.ParsePrivateKey(key)
	if e != nil {
		return errors.New("cannot parse provisioning key")
	}
	cfg := &ssh.ClientConfig{User: "provisioner", Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, HostKeyAlgorithms: []string{ssh.KeyAlgoED25519}, HostKeyCallback: func(_ string, _ net.Addr, k ssh.PublicKey) error {
		expected := []byte(*m.Pin)
		actual := []byte(ssh.FingerprintSHA256(k))
		if subtle.ConstantTimeCompare(expected, actual) != 1 {
			return errors.New("SSH host key mismatch")
		}
		return nil
	}, Timeout: 5000 * time.Millisecond}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	dial := p.DialContext
	if dial == nil {
		dial = (&net.Dialer{}).DialContext
	}
	conn, e := dial(bounded, "tcp", net.JoinHostPort(m.IP, "22"))
	if e != nil {
		return errors.New("SSH connection failed")
	}
	defer conn.Close()
	deadline, _ := bounded.Deadline()
	conn.SetDeadline(deadline)
	stop := context.AfterFunc(bounded, func() { conn.Close() })
	defer stop()
	c, ch, req, e := ssh.NewClientConn(conn, m.IP, cfg)
	if e != nil {
		return errors.New("SSH handshake failed")
	}
	client := ssh.NewClient(c, ch, req)
	defer client.Close()
	session, e := client.NewSession()
	if e != nil {
		return errors.New("SSH session failed")
	}
	defer session.Close()
	session.Stdin = strings.NewReader(input)
	if e = session.Run(cmd); e != nil {
		return errors.New("SSH lifecycle command failed")
	}
	return nil
}
