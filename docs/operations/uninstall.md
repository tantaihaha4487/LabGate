# Uninstall or decommission

[Operations index](README.md) · [Full reference](../OPERATIONS.md) · [Back to README](../../README.md)

There is no safe one-command uninstall. Decommissioning is a security change:

1. Stop new checkout traffic and drain the physical session.
2. Run boot-lock recovery and prove the endpoint is locked, session-free, and dormant-safe.
3. Quarantine the endpoint on the Pi; do not present it to students.
4. Disable heartbeat, cleanup, and webhook-flush timers while keeping boot lock.
5. Back up PAM files, remove only LabGate PAM hooks, and verify no hook remains.
6. Keep guest SSH denial, provisioner forced-command restrictions, and boot lock until the shared identity is deliberately retired through a reviewed process.

See [temporary disable](../OPERATIONS.md#temporarily-disable-the-display-manager-hook)
and [fully remove PAM integration](../OPERATIONS.md#fully-remove-labgate-pam-integration)
for the exact commands. Do not delete `/etc/labgate` or the machine database row
as a shortcut.
