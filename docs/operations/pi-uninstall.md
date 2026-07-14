# Remove the Pi application

[Operations index](README.md) · [Documentation hub](../README.md) · [Back to README](../../README.md)

This removes the running LabGate application from the Pi only. It does not
erase enrolled endpoints, the repository, the SQLite database, secrets, or
bind-mounted data. Decommission every endpoint first using the
[machine uninstall runbook](uninstall.md).

```sh
cd ~/LabGate
./deploy/uninstall-pi.sh prepare --confirm
# Secure every physical endpoint with machine-setup/uninstall-machine.sh.
./deploy/uninstall-pi.sh finalize --confirm
```

`prepare` stops checkout traffic and leaves the Compose service stopped.
`finalize` removes the stopped Compose application and network without deleting
bind-mounted data. The script refuses to mutate the Pi without `--confirm` and
supports `--dry-run` for inspection. It never uses the
`docker compose down --volumes` option.

Retain the database and any institution-approved backup according to the
retention policy. Remove DNS/reverse-proxy entries, firewall rules, and the
Pi's Tailscale service only if the host has no other tailnet workloads.

For rollback or a later reinstall, preserve the backup and follow the [Pi install guide](pi-install.md).
