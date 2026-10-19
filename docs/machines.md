# Physical machine installation

Use the matching release archive on Debian 12/13, Ubuntu Desktop, or an Arch-family desktop and run `./install.sh`, selecting **Lab machine**. The retained installer checks distro dependencies, Tailscale connectivity, supported password-based display-manager PAM stacks, effective sudo policy, forced-command SSH, guest account protections, and the universal guest Polkit deny rule.

The installer prompts for the canonical API origin, machine name, password length, home mode, registration secret, and provisioning public key. Secrets are read privately. `n` provides a fresh tmpfs home per physical session; `y` preserves disk-backed home contents while sealing the dormant directory and retaining external-state cleanup.

Machine lifecycle helpers are native Go ELF executables installed at the historical paths:

```text
/usr/local/sbin/guest-account.sh
/usr/local/sbin/guest-session-hook.sh
/usr/local/sbin/guest-cleanup.sh
/usr/local/sbin/guest-boot-lock.sh
/usr/local/sbin/guest-heartbeat.sh
/usr/local/sbin/guest-webhook-flush.sh
/usr/local/sbin/labgate-provisioner-dispatch.sh
/usr/local/sbin/labgate-deny-guest-account-change.sh
```

The `.sh` suffix preserves installed PAM, sudoers, and SSH command contracts. Lifecycle code does not source Bash or shell out to SSH. It uses fixed absolute system utilities with bounded execution and a reset environment. The common Bash library remains only for installer maintenance glue.

Machine state remains in `/var/lib/labgate`, including the existing tab-separated state record, integer tombstones, persistent outbox sequence, and ordered event files. Tokens and configuration stay root-only under `/etc/labgate`. PAM never performs network requests: it completes local lifecycle work and queues an event. A systemd path trigger wakes delivery, with a timer for retries.

Upgrade helpers only on a locked, drained machine with no guest processes, mounted guest home, or linger marker. Preserve pending outbox records and the sequence. Unknown/corrupt records block progression; the Go runtime never silently discards them. Legacy clock-named queues require the separate `sudo bash machine-setup/migrate-outbox.sh` command on a drained machine. Installation refuses those queues and never migrates them. Delivery triggers remain stopped until the subsequent helper installation succeeds.

Enrollment from the admin website or TUI uses the same backend as the installer. Registration is immutable/idempotent for the exact name/address/pin triple. Rekey requires a drained machine and the exact expected identity. Install its returned token root-only and retain the machine offline until a safe heartbeat is accepted. Never use rekey as a shortcut to clear a safety hold.

To remove a machine, run `sudo labgate uninstall --role machine` (or the packaged compatibility entrypoint `machine-setup/uninstall-machine.sh --confirm`). Follow [physical acceptance](recovery.md) before serving students.
