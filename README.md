# LabGate

LabGate lets a student authenticate with an `@ubu.ac.th` Google account,
reserve a shared physical Ubuntu Desktop machine, and receive a temporary
password for that machine's one pre-existing `guest` account. The password is
typed at the physical login screen; LabGate is not remote desktop software.

The web application returns each generated password once and never stores it.
Every new checkout rotates the shared password for a new credential generation.
Logout, pending-login expiry, boot recovery, and local safety recovery lock the
same account rather than creating or deleting student identities.

> [!IMPORTANT]
> Physical end-to-end validation is a release gate. Check [PROGRESS.md](PROGRESS.md)
> and complete the physical acceptance checks in the [operations guides](docs/operations/operations-and-recovery.md) before treating a machine
> as ready for students.

## Start here

Use the runbook for any deployment or machine change. It is organized as a
human-readable path, and each major section links back here.

1. [Install the Raspberry Pi application](docs/operations/pi-install.md)
2. [Configure Google OAuth and HTTPS](docs/operations/configuration.md)
3. [Enroll the first lab machine](docs/operations/lab-machine-enrollment.md)
4. [Enroll additional lab machines](docs/operations/lab-machine-enrollment.md)
5. [Operate, update, and recover the deployment](docs/operations/operations-and-recovery.md)
6. [Uninstall or decommission a machine](docs/operations/uninstall.md)
7. [Uninstall the Pi application](docs/operations/pi-uninstall.md)

The short version is: deploy the Pi once, run `setup-machine.sh` once per
physical endpoint, and never manually copy a machine's webhook token or the
Pi's provisioning private key.

## Credential lifecycle

`CREDENTIAL_TTL_HOURS` is the time allowed to use a newly issued password at the
physical login screen. It is not a desktop-session limit.

There is no maximum duration for an active session unless you specify one.

| Machine state | Version | Meaning | Deadline behavior |
|---|---:|---|---|
| `pending` | 1 | Password issued; no physical PAM session opened | At the deadline, local cleanup locks it and advances to version 3 |
| `active` | 2 | Physical PAM open succeeded and a fresh tmpfs home is mounted | Original deadline is ignored; machine stays occupied |
| `revoked` | 3 | Account lock, process termination, and home unmount completed | Server may release only this exact generation |

The state version is monotonic within one credential ID. A delayed event from an
older generation cannot close or reopen a newer checkout. A stale heartbeat or
unreachable host is not evidence that the local account is locked, so the server
keeps that machine occupied until it receives confirmed safe state.

If the physical endpoint reports an unexpected active or pending generation,
LabGate terminalizes any conflicting current database row and stores the reported
ID in `machines.safety_hold_credential_id`. That persistent hold keeps the machine
occupied even if an unrelated delayed close arrives. Release requires locked
version 3 for the held ID, or a genuinely locked no-state heartbeat with no
current database credential.

## Architecture

```text
Student browser --HTTPS--> Raspberry Pi 5 --SSH over Tailscale--> Physical lab machine
                              ^                                  |
                              |------ versioned webhooks --------|
```

- The Pi runs Next.js, Better Auth, SQLite/Prisma, and the provisioning service
  with Docker Compose.
- Google supplies authentication and LabGate independently checks the server-side
  email suffix.
- Provisioning uses `node-ssh` with explicit timeouts and a dedicated key.
- Every connection is pinned to the endpoint's canonical Ed25519 SHA256 host-key
  fingerprint; Tailscale reachability is not treated as host authentication.
- The machine's `provisioner` SSH identity is forced through a strict dispatcher;
  it uses `/bin/sh` only as the forced-command launcher, authenticates by public
  key only, and is not a general-purpose shell. Its home is root-owned; only its
  `.ssh` child and key file are provisioner-owned.
- The physical `guest` identity is denied SSH access.
- PAM performs local state changes only. It writes versioned events to a
  root-controlled persistent outbox, and a separate timer retries delivery.
- Outbox filenames use a durable fixed-width monotonic sequence, not timestamps.
  Producers take only a short local sequence lock, so a blocked webhook request
  can never delay PAM or another local event publication.
- Valid authenticated lifecycle events are transport-acknowledged after their
  transactional state decision even when that decision is held/conflict/not-found,
  so an ordered outbox cannot strand a later exact close behind an old event.
- Cleanup, heartbeat, webhook-flush, and boot-lock systemd units provide
  independent reconciliation and fail-safe recovery.

## Required configuration

Copy `.env.example` to `.env.local` and keep the result out of source control.

| Variable | Purpose |
|---|---|
| `BETTER_AUTH_URL` | Exact public application origin used by Google OAuth |
| `BETTER_AUTH_SECRET` | Better Auth signing secret |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth web client |
| `ALLOWED_EMAIL_DOMAIN` | Server-enforced institution suffix; default `ubu.ac.th` |
| `DATABASE_URL` | SQLite path; Compose uses `file:./data/labgate.db` |
| `PROVISIONER_SSH_KEY_PATH` | Absolute readable non-empty regular mode-`0600` private-key path; Compose uses `/run/secrets/provisioner_key` |
| `CREDENTIAL_TTL_HOURS` | Pending physical-login deadline, from one minute through 24 hours |
| `GUEST_PASSWORD_LENGTH` | Exact generated length, whole number from 8 through 128 |
| `MACHINE_REGISTRATION_SECRET` | Authenticates first machine registration |
| `CRON_SECRET` | Authenticates the Pi recovery sweep |

`GUEST_PASSWORD_LENGTH` has no silent deployment fallback when a malformed value
is supplied. A configured value of `8` always generates exactly eight characters.
Every machine must be installed with the identical `LABGATE_PASSWORD_LENGTH`,
which is persisted in root-only `/etc/labgate/password-length` and independently
enforced before password rotation.

The machine also rejects an issued pending deadline more than 24 hours plus a
fixed 60-second NTP clock-skew allowance into its future. This is an independent
upper bound on the login window, not an active-session duration limit.

`MACHINE_REGISTRATION_SECRET` and `CRON_SECRET` accept 20–256-character RFC 6750
`b64token` values. Standard Base64 `+`, `/`, and trailing `=` padding are valid,
as are URL-safe tokens; whitespace and quoting are not. Existing URL-safe Pi
secrets remain valid, so this compatibility expansion alone requires no rotation.

Per-machine webhook tokens are generated at registration. They live in the
database and root-only machine files, not `.env.local`.

## Local development

Requirements: Node.js 22 or newer, npm, SQLite-compatible Prisma dependencies,
and a Google OAuth client whose redirect list includes:

```text
http://localhost:3000/api/auth/callback/google
```

Setup:

```sh
npm install
mkdir -p data secrets
cp .env.example .env.local
npx prisma generate
npx prisma migrate dev
npm run dev
```

For a local process rather than Compose, use local filesystem paths:

```dotenv
BETTER_AUTH_URL=http://localhost:3000
DATABASE_URL=file:./data/labgate.db
PROVISIONER_SSH_KEY_PATH=./secrets/provisioner_key
```

Before committing:

```sh
npm test
npm run lint
npm run build
```

## Raspberry Pi deployment rule

The production clone is `~/LabGate` on:

```text
labgate-1@raspberrypi.tailfdedcf.ts.net
```

Tracked project files must never be edited ad hoc on the Pi. Make the change on
the development machine, validate it, commit it, push it, and only then update
the Pi with a fast-forward pull. Runtime-only configuration such as `.env.local`
and root-owned secret files may be changed directly on the Pi.

The safe production sequence—including SQLite backup, duplicate-active-row
preflight, migration inspection, pull, Compose rollout, health checks, and
rollback—is in the [documentation hub](docs/README.md).

The first lifecycle-protocol rollout has a mandatory drained upgrade gate: stop
checkout, enumerate and physically secure every unrevoked database generation,
transactionally mark only verified rows revoked, install the new machine
protocol, prove dormant-safe null-or-revoked state, and only then migrate/start
the Pi and reopen checkout. This gate also checks that machine names and Tailscale
addresses uniquely identify one physical endpoint.

Startup also fails closed for non-canonical/duplicate endpoint identities or SSH
host-key pins and an
`available` machine that still has a current credential or safety hold. An
`occupied` machine with no current credential remains quarantined and produces an operator warning;
it is not silently released. Registration `POST` binds the exact name, canonical
Tailscale address, and Ed25519 host-key pin and cannot rename, move, merge, or
rekey an existing identity. A new enrollment begins offline with a null heartbeat;
an exact POST replay returns the stable token without mutating state, and only a
strict authenticated locked/session-free heartbeat can make it available. A separate authenticated `PATCH` supports reviewed
drained rekey only when the machine is available with no current credential and
no safety hold; it rotates the token and holds the replacement identity offline
until a safe locked, session-free heartbeat arrives.

## Machine enrollment and updates

Each Ubuntu Desktop endpoint requires:

- Tailscale connectivity to the Pi;
- OpenSSH Server, PAM, Polkit, systemd, `curl`, `sudo`, `keyctl`, and the
  util-linux IPC tools;
- one existing administrator identity and the dedicated infrastructure
  `provisioner` identity initially using verified `nologin`, a root-owned home,
  and no authorized key;
- the provisioning public key; and
- the complete committed `machine-setup/` directory.

`setup-machine.sh` installs or updates scripts, root-only configuration, PAM and
Polkit policy, SSH policy, sudoers policy, and systemd units idempotently. It terminates
old provisioner processes, validates the forced dispatcher and sudoers, and only
then changes the service shell to `/bin/sh`; its shadow password remains locked
and physical PAM account paths deny it. Install `authorized_keys` after setup
completes. Initial registration reads `LABGATE_REGISTRATION_SECRET`; normal updates
preserve the existing per-machine token only when the root-only persisted Ed25519
host-key pin matches the live key. A legacy token without that marker or a changed
key requires the explicit drained rekey procedure. Never copy the Pi's provisioning private
key to a lab machine.

`LABGATE_API_URL` is an origin, not a general URL: for example,
`http://100.64.0.5:3000` or `https://raspberrypi.example.ts.net`. Userinfo, a
trailing slash/path, query, fragment, non-canonical host text, and invalid ports
fail setup. When no valid existing token/pin pair is present, the registration
secret is validated before setup can mutate account, PAM, or SSH policy and is
validated again immediately before registration.

An endpoint with the old clock-named outbox format is an explicit drained
maintenance migration. Setup refuses it by default. After boot-lock recovery has
proved the guest locked with no session, process, or mount, rerun with
`LABGATE_MIGRATE_LEGACY_OUTBOX=1`; setup journals every affected credential,
queues authoritative version-3 terminal reports, and preserves the old files in
a root-only archive. See the operations runbook before using this flag.

Only the supported GDM, LightDM, or SDDM password PAM stack may be selected. Setup
rejects a selected auth graph containing `pam_fprintd.so`, denies known alternate
display-manager paths to `guest`, and fails on unknown matching paths for manual
review. It also denies non-root guest self-service through `passwd`, `chsh`, and
`chfn` while retaining explicit root maintenance. The selected auth graph is
checked for `pam_faillock`, `pam_tally2`, and `pam_tally`; every issue resets all
detected counters and enforces non-expiring guest password aging before unlock.

The exact committed Polkit rule denies every privileged broker action when the
subject user is `guest`; it has no rule for root, administrators, or `provisioner`.
This is an intentional compatibility boundary: the shared guest loses all
privileged desktop broker actions, so administrators must perform system changes
from their own identity. Every local secure flow also disables guest linger and
must remove `/var/lib/systemd/linger/guest` before process cleanup.
Setup also validates the complete sudoers policy and accepts enrollment only when
sudo's resolved policy proves `guest` has no command grant; it does not trust a
deny line that a different sudoers rule could override.

Local revocation is broader than the tmpfs home: after terminating guest-owned
processes it clears the exact `/run/user/<guest UID>` tree, guest-owned POSIX
mqueues, guest-created/owned System V IPC, the guest persistent keyring, exact
guest mailbox paths, and guest-owned entries on `/tmp`, `/var/tmp`, and `/dev/shm`.
PAM open recreates the runtime directory empty at mode 0700. The cleanup is
intentionally bounded; administrators must not grant the shared account other
persistent writable locations and must not replace it with a filesystem-wide scan.

Use [the operations index](docs/operations/README.md) for
the exact installation, update, PAM inspection/reset/disable, recovery, timer,
state, outbox, logging, and security-check procedures.

## Safety model

- Exactly one shared physical-desktop account exists on each endpoint.
- The web database and persistent machine state never contain the generated
  guest password.
- Passwords use only the unambiguous alphanumeric set and exactly the configured
  length.
- An issue password is sent as one newline-terminated SSH stdin line, never in
  `SSH_ORIGINAL_COMMAND`, sudo argv, process listings, or logs.
- Credential IDs and state versions scope every issue, revoke, webhook, and
  recovery action to one generation.
- A persistent server-side safety hold records either one exact unexpected
  physical generation or a reserved conflict sentinel when multiple generations
  are implicated. Unrelated closes cannot release it; only a fresh globally safe
  heartbeat can clear a conflict, and checkout/rekey require the hold to be null.
- Root-controlled tombstones prevent a terminal generation ID—including one
  compensated before pending state existed—from ever being issued later.
- PAM open remounts `/home/guest` as a new verified tmpfs; PAM close locks first,
  terminates guest-owned processes, and performs a verified non-lazy unmount.
- Secure close/recovery clears the bounded runtime, scratch, IPC, keyring, and
  mailbox surfaces; failure to prove any one clear keeps the endpoint unsafe.
- Local safety does not depend on the Pi or network. Webhook retry does not run
  in the PAM transaction.
- Boot lock runs before display-manager and SSH login services.
- A guest-only universal Polkit denial blocks privileged desktop broker paths;
  secure close/recovery removes and verifies the guest linger marker before
  terminating processes. Root, administrator, and provisioner policy is unchanged.
- A release-capable no-state heartbeat is emitted only after that full secure
  transaction and PAM-marker cleanup succeeds. Corrupt state is secured locally
  but withheld from no-state reconciliation.
- Root-owned PAM guards prevent the non-root shared guest from persistently
  changing its password, login shell, or GECOS data while retaining explicit
  root maintenance.
- Machines remain occupied whenever server state cannot prove a confirmed lock
  and inactive session.
- Bearer values belong in permission-restricted files, never command arguments,
  crontab text, logs, screenshots, or tickets.
- Provisioner SSH is public-key-only, rejects user environment/startup files and
  non-locale `AcceptEnv`, and invokes only fixed `/usr/bin/sudo` through the
  validated dispatcher. Its password is locked and physical PAM paths deny it.
- The Pi verifies the exact registered Ed25519 host-key SHA256 pin before any
  provisioning command; setup will not silently enroll a legacy null pin.

## Documentation

- [AGENTS.md](AGENTS.md) — binding architecture and security invariants
- [BUILD_PROMPT.md](BUILD_PROMPT.md) — phased implementation and evidence gates
- [PROGRESS.md](PROGRESS.md) — current completion status and blockers
- [docs/operations/README.md](docs/operations/README.md) — deployment and machine operations
- [docs/README.md](docs/README.md) — documentation hub and operator routing
- [.env.example](.env.example) — application configuration template
- [machine-setup/](machine-setup/) — endpoint installer and lifecycle units
