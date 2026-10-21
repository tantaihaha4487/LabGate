package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"labgate/internal/config"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type Connection struct {
	Origin string `json:"origin"`
	Token  string `json:"token,omitempty"`
}

func ClientPath() string {
	p, e := os.UserConfigDir()
	if e != nil {
		p = "."
	}
	return filepath.Join(p, "labgate", "client.json")
}
func LoadConnection() (Connection, error) {
	var c Connection
	s, e := os.Stat(ClientPath())
	if e != nil {
		return c, e
	}
	if s.Mode().Perm() != 0600 {
		return c, errors.New("client configuration must have mode 0600")
	}
	b, e := os.ReadFile(ClientPath())
	if e == nil {
		e = json.Unmarshal(b, &c)
	}
	return c, e
}
func SaveConnection(c Connection) error { return config.Save(ClientPath(), c) }

type Client struct {
	Connection
	HTTP *http.Client
}

func NewClient(c Connection) *Client {
	return &Client{c, &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (c *Client) Request(ctx context.Context, method, path string, input, out any) (int, error) {
	var b []byte
	var e error
	if input != nil {
		b, e = json.Marshal(input)
		if e != nil {
			return 0, e
		}
	}
	r, e := http.NewRequestWithContext(ctx, method, c.Origin+path, bytes.NewReader(b))
	if e != nil {
		return 0, e
	}
	r.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		r.Header.Set("Authorization", "Bearer "+c.Token)
	}
	res, e := c.HTTP.Do(r)
	if e != nil {
		return 0, errors.New("Server unreachable. Check connection settings and retry.")
	}
	defer res.Body.Close()
	data, e := io.ReadAll(io.LimitReader(res.Body, 1024*1024))
	if e != nil {
		return res.StatusCode, e
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var v struct {
			Error string `json:"error"`
		}
		json.Unmarshal(data, &v)
		if v.Error == "" {
			v.Error = fmt.Sprintf("Server returned %d", res.StatusCode)
		}
		return res.StatusCode, errors.New(v.Error)
	}
	if out != nil {
		e = json.Unmarshal(data, out)
	}
	return res.StatusCode, e
}
