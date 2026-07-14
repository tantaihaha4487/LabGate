# Remove the Pi application

[Operations index](README.md) · [Full reference](../OPERATIONS.md) · [Back to README](../../README.md)

This removes LabGate from the Pi only. It does not erase enrolled endpoints.
Decommission or quarantine every endpoint first, and retain the database backup
for the institution's retention period.

```sh
cd ~/LabGate
docker compose stop labgate
install -d -m 700 backups
cp --preserve=mode data/labgate.db "backups/labgate-before-remove-$(date +%Y%m%d-%H%M%S).db"
docker compose down
```

Remove the checkout and root-only secrets only after confirming the backup and
retention decision. Do not use `docker compose down --volumes` unless deleting
all application data is explicitly approved. Remove DNS/reverse-proxy entries,
firewall rules, and the Pi's Tailscale service only if the host has no other
tailnet workloads.

For rollback or a later reinstall, preserve the backup and follow the [Pi install guide](pi-install.md).
