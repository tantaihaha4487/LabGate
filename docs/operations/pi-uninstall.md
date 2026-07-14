# Remove the Pi application

[Operations index](README.md) · [Documentation hub](../README.md) · [Back to README](../../README.md)

This removes LabGate from the Pi only. It does not erase enrolled endpoints.
Decommission or quarantine every endpoint first, and retain the database backup
for the institution's retention period.

```sh
cd ~/LabGate
sh deploy/save-database.sh
docker compose down
```

`save-database.sh` stops the service, creates a SQLite-native backup under
`backups/`, sets its mode to `0600`, and verifies both SQLite integrity and
foreign-key consistency. It leaves the service stopped. If either check fails,
do not continue with `docker compose down`; preserve the failed backup and
investigate it first.

Remove the checkout and root-only secrets only after confirming the backup and
retention decision. Do not use `docker compose down --volumes` unless deleting
all application data is explicitly approved. Remove DNS/reverse-proxy entries,
firewall rules, and the Pi's Tailscale service only if the host has no other
tailnet workloads.

For rollback or a later reinstall, preserve the backup and follow the [Pi install guide](pi-install.md).
