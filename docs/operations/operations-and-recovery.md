# Operate and recover

[Operations index](README.md) · [Documentation hub](../README.md) · [Back to README](../../README.md)

Never release a machine solely because its heartbeat stopped or a deadline
expired. Release requires confirmed version-3 revocation, a locked `guest`, and
no physical session.

For incidents, stop assigning the machine, preserve logs and outbox metadata,
run fail-safe boot-lock recovery, and reconcile the exact credential generation
and safety hold with the Pi.

- [Project contract and safety invariants](../../AGENTS.md)
- [Progress and acceptance status](../../PROGRESS.md)
