# Operate and recover

[Operations index](README.md) · [Full reference](../OPERATIONS.md) · [Back to README](../../README.md)

Never release a machine solely because its heartbeat stopped or a deadline
expired. Release requires confirmed version-3 revocation, a locked `guest`, and
no physical session.

For incidents, stop assigning the machine, preserve logs and outbox metadata,
run fail-safe boot-lock recovery, and reconcile the exact credential generation
and safety hold with the Pi.

- [Manual issue/revoke/recovery](../OPERATIONS.md#manual-issue-revoke-and-recovery)
- [State, outbox, and logs](../OPERATIONS.md#state-outbox-recovery-marker-and-logs)
- [Timers and boot ordering](../OPERATIONS.md#timers-and-boot-ordering)
- [Security checks](../OPERATIONS.md#security-and-dormant-safe-checks)
- [Rollback](../OPERATIONS.md#rollback)
