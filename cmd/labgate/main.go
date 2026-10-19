package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"labgate/internal/cli"
	"labgate/internal/config"
	"labgate/internal/core"
	"labgate/internal/server"
	"labgate/internal/store"
	"labgate/web"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var version = "dev"

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run() error {
	command := "tui"
	args := os.Args[1:]
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}
	switch command {
	case "version", "--version":
		fmt.Println("LabGate", version)
		return nil
	case "help", "--help", "-h":
		fmt.Println("labgate                 Open admin TUI (first run guides connection)\nlabgate setup --server  Configure server; never migrates database\nlabgate serve           Run server (normally managed by systemd)\nlabgate uninstall       Remove server, admin client, or machine integration\nlabgate version         Show version\n\nDatabase preparation is a separate executable: labgate-migrate")
		return nil
	case "uninstall":
		return cli.Uninstall(args, os.Stdin, os.Stdout)
	case "setup":
		f := flag.NewFlagSet("setup", flag.ContinueOnError)
		serverMode := f.Bool("server", false, "configure local server")
		p := f.String("config", config.Path(), "server config path")
		if e := f.Parse(args); e != nil {
			return e
		}
		if *serverMode {
			return cli.SetupServer(*p)
		}
		return cli.SetupClient()
	case "serve", "check":
		f := flag.NewFlagSet("serve", flag.ContinueOnError)
		p := f.String("config", config.Path(), "server config path")
		if e := f.Parse(args); e != nil {
			return e
		}
		c, e := config.Load(*p)
		if e != nil {
			return e
		}
		if e = c.Validate(); e != nil {
			return e
		}
		s, e := store.Open(c.Database)
		if e != nil {
			return e
		}
		defer s.Close()
		if command == "check" {
			fmt.Println("Configuration and existing schema are valid.")
			return nil
		}
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		api := server.New(core.New(s, c, core.SSH{KeyPath: c.KeyPath}), web.Handler())
		go api.SweepLoop(ctx)
		h := &http.Server{Addr: c.Listen, Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 40 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
		go func() {
			<-ctx.Done()
			bounded, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			h.Shutdown(bounded)
		}()
		fmt.Printf("LabGate %s listening on %s\n", version, c.Listen)
		e = h.ListenAndServe()
		if errors.Is(e, http.ErrServerClosed) {
			return nil
		}
		return e
	case "tui", "login":
		c, e := cli.LoadConnection()
		if os.IsNotExist(e) {
			if e = cli.SetupClient(); e != nil {
				return e
			}
			c, e = cli.LoadConnection()
		}
		if e != nil {
			return e
		}
		if !config.Origin(c.Origin) {
			return errors.New("invalid saved server origin; run labgate setup")
		}
		return cli.Run(cli.NewClient(c))
	default:
		return fmt.Errorf("unknown command %q; run labgate help", command)
	}
}
