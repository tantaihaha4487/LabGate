package main

import (
	"context"
	"fmt"
	"labgate/internal/machine"
	"os"
	"path/filepath"
	"time"
)

func main() {
	name := filepath.Base(os.Args[0])
	args := os.Args[1:]
	if name == "labgate-machine" && len(args) > 0 {
		name = args[0]
		args = args[1:]
	}
	if name == "labgate-deny-guest-account-change.sh" {
		if os.Getenv("PAM_USER") == "guest" && os.Getuid() != 0 {
			os.Exit(1)
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 28*time.Second)
	defer cancel()
	runner := machine.ExecRunner{}
	if name == "labgate-provisioner-dispatch.sh" {
		v, input, e := machine.Dispatch(os.Getenv("SSH_ORIGINAL_COMMAND"), os.Stdin)
		if e == nil {
			_, e = runner.Command(ctx, input, "/usr/bin/sudo", v...)
		}
		if e != nil {
			fmt.Fprintln(os.Stderr, "LabGate provisioner command denied or failed.")
			os.Exit(126)
		}
		return
	}
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "LabGate lifecycle helpers require root.")
		os.Exit(1)
	}
	m := machine.New("/", runner)
	var e error
	switch name {
	case "guest-account.sh":
		e = m.Account(ctx, args, os.Stdin)
	case "guest-session-hook.sh":
		e = m.PAM(ctx, os.Getenv, os.Getppid())
	case "guest-cleanup.sh":
		e = m.Cleanup(ctx, false)
	case "guest-boot-lock.sh":
		e = m.Cleanup(ctx, true)
	case "guest-heartbeat.sh":
		e = m.Heartbeat(ctx)
	case "guest-webhook-flush.sh":
		e = m.Flush(ctx)
	default:
		e = fmt.Errorf("unknown helper")
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, "LabGate lifecycle operation failed; check local state and recovery marker.")
		os.Exit(1)
	}
}
