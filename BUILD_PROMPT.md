# Build prompt — LabGate

Give this entire file to the coding agent. Read `AGENTS.md` first; it is the
project contract. Preserve every security invariant and work through the phases
in order. A phase is complete only after its stated evidence exists. Commit the
matching `PROGRESS.md` update with that phase's code.

## Confirmed lifecycle contract

LabGate controls one pre-existing physical-desktop account named `guest` on
each machine. It never creates a per-student operating-system identity. Checkout
rotates that account's password and returns the password once; the web app never
persists it.

`GUEST_PASSWORD_LENGTH` is exact. The application must generate exactly that
many unambiguous, shell-safe characters, and the machine must enforce the same
value from `/etc/labgate/password-length`. Supported values are 8–128.

`CREDENTIAL_TTL_HOURS` is a pending physical-login deadline:

1. Checkout creates one credential generation, marks the machine `occupied`,
   and issues state `pending` / version `1` to the machine.
2. Physical PAM open before the deadline creates a fresh tmpfs home and advances
   the same generation to `active` / version `2`.
3. Physical PAM close locally locks the account, terminates guest-owned
   processes, unmounts the tmpfs, and advances to `revoked` / version `3`.
4. If no physical login happens before the deadline, local cleanup performs the
   same secure revocation and reports version `3`.
5. The server returns a machine to `available` only after an exact-generation
   version-3 report or heartbeat confirms the locked, inactive state. A timeout,
   network failure, or stale heartbeat by itself must not release it.

There is no maximum duration for an active session unless you specify one.

Machine lifecycle webhooks are generation-scoped and idempotent. State versions
are monotonic: delayed version-1 or version-2 data cannot downgrade version 3,
and an event for an old credential ID cannot mutate a newer reservation.

`machines.safetyHoldCredentialId` is the server's persistent physical-generation
quarantine. An unexpected active/pending report terminalizes any current DB row,
stores either the single unsafe physical ID or the reserved conflict sentinel
when more than one generation is implicated, and keeps the endpoint occupied.
An unrelated terminal event cannot clear it. Locked version 3 may clear only a
matching single-generation hold. A conflict hold requires a fresh, genuinely
locked no-state heartbeat with no current DB row.

PAM performs no networking. It queues root-controlled, versioned events in a
persistent outbox; a systemd timer delivers them in order. Boot recovery secures
the guest account before display-manager and SSH login services. The `guest`
identity cannot use SSH, and the `provisioner` identity is a strict forced-command
transport, not a shell.

## Step 0 — Resume safely

Before editing:

1. Read `AGENTS.md` and `PROGRESS.md`.
2. Inspect the working tree and preserve unrelated changes.
3. Do not redo a checked phase unless new evidence demonstrates a regression.
4. Record blockers instead of silently skipping required physical validation.

If `PROGRESS.md` does not exist, create it before code with the phase checklist
below plus `## Notes / deviations` and `## Blockers`.

## Phase 0 — Application and deployment scaffold

- Next.js App Router and strict TypeScript; server components by default.
- npm as the package manager.
- Docker Compose on the Raspberry Pi with persistent `./data` and a read-only
  provisioning key mount.
- Production entrypoint validates configuration and database identity/lifecycle
  conflicts, then runs `prisma migrate deploy` before starting Next.js.
- Startup requires every secret/URL/domain/database setting, validates TTL and
  exact password length, and requires the provisioning key path to be absolute,
  readable, non-empty, regular, mode `0600`, and not a symlink.
- Registration and cron secrets accept 20–256-character RFC 6750 `b64token`
  values, including standard Base64 `+`, `/`, and terminal `=` padding; an
  existing URL-safe secret remains valid without rotation.
- `.env.example` documents every required variable but contains no secret.

**Done when:** local development starts, Compose health becomes healthy, and no
secret or database file is tracked.

## Phase 1 — Database and migration guards

- SQLite through Prisma only in application code.
- LabGate models include machines, guest credential generations, and audit logs;
  Better Auth owns its user/session/account/verification models.
- Guest credentials store `sessionOpenedAt` and `machineStateVersion`, never a
  password.
- Machines store nullable `safetyHoldCredentialId` without a foreign key because
  an authoritative physical generation may be unknown to the database.
- Partial unique indexes allow only one non-revoked credential per machine and
  per case-normalized student email.
- Machine name, Tailscale address, and canonical Ed25519 SHA256 SSH host-key pin
  are each unique so one physical endpoint cannot acquire two database identities;
  the address must be canonical Tailscale CGNAT IPv4 text.
- Startup fails if an available machine has a current credential or non-null
  safety hold. Occupied with no current credential is a quarantine warning and
  remains occupied for manual reconciliation.
- Production instructions back up SQLite and query for duplicate machine
  identities and active rows before applying the uniqueness migration.

**Done when:** migrations apply to a clean test database, duplicate preflight
queries are documented, and concurrency tests prove the database constraints.

## Phase 2 — Authentication

- Better Auth Google provider includes the allowed hosted-domain hint.
- Every server-side session boundary independently validates the normalized
  email suffix against `ALLOWED_EMAIL_DOMAIN`.
- Unauthenticated users are redirected and API routes reject them.

**Done when:** a non-institution account is rejected by the server even if the
hosted-domain request hint is missing or forged.

## Phase 3 — Checkout and exact password configuration

- Validate `GUEST_PASSWORD_LENGTH` at startup and before generation; reject
  malformed, fractional, below-8, or above-128 values instead of silently
  defaulting.
- Generate exactly the configured number of characters from the unambiguous
  alphanumeric set.
- Claim a machine with one atomic conditional update; never read then write.
- Insert the credential generation without a password and provision with its ID,
  future deadline, and generated password.
- On provisioning failure, attempt the exact compensating revoke. Confirmed lock
  terminalizes the row and may release; ambiguous issue plus failed compensation
  keeps that row unrevoked/expired, holds its exact ID, and remains occupied so
  the sweep retries the same SSH revoke.
- Return `{ username, password, expiresAt }` once in the response.

**Done when:** configured length `8` always returns eight characters, and two
concurrent requests for one machine produce exactly one success and one `409`.

## Phase 4 — Generation-scoped SSH provisioning

- Use `node-ssh` in Node runtime code; never invoke a shell SSH client.
- Validate credential IDs with exact pattern `[A-Za-z0-9_-]{20,64}`.
- Validate a real future `Date`, convert it to positive safe Unix seconds, and
  validate the password before connecting. The machine independently rejects an
  issue deadline beyond 24 hours plus a fixed 60-second clock-skew allowance.
- Preserve explicit connection and command timeouts.
- The only remote commands are:

  ```text
  sudo /usr/local/sbin/guest-account.sh issue <credential-id> <expires-at-unix>
  sudo /usr/local/sbin/guest-account.sh revoke <credential-id>
  ```

- Send the issue password as exactly one newline-terminated line on SSH stdin.
  It must never appear in `SSH_ORIGINAL_COMMAND`, sudo argv, process listings, or
  logs. The dispatcher and root script independently reject missing, extra, or
  malformed stdin.
- Treat a non-zero exit as failure and never return the password after failure.

**Done when:** unit tests exercise validation and exact command construction
without opening SSH, followed by an isolated real-machine provisioning test.

## Phase 5 — Machine lifecycle and local safety

- `setup-machine.sh` is idempotent and writes root-controlled configuration.
- It accepts the Pi API URL only as an origin-only HTTP(S) URL with a canonical
  lowercase hostname or IPv4 and optional port 1–65535; reject credentials,
  path/slash, query, fragment, malformed/non-canonical host text, and invalid
  ports. The runtime sender re-validates the persisted origin.
- On first registration, validate the required RFC 6750 bearer before changing
  account, PAM, or SSH policy, then validate it again inside the registration
  network helper. A matching existing token/pin update needs no registration
  bearer.
- App `GUEST_PASSWORD_LENGTH` and machine `LABGATE_PASSWORD_LENGTH` must match
  exactly.
- `guest-account.sh` independently validates action, generation ID, deadline,
  charset, and exact password length.
- A single lifecycle lock serializes issue, revoke, PAM, cleanup, heartbeat
  snapshots, and boot recovery.
- Persistent state contains exactly generation ID, deadline, state, version, and
  changed-at time; it contains no password.
- Root-controlled terminal-generation tombstones prevent reuse after completed
  or failed-issue compensating revoke.
- PAM open accepts only a matching unexpired pending generation, mounts a fresh
  verified tmpfs, records its ownership marker, then writes active/version 2.
- PAM close accepts only its own marker, secures the account locally first, then
  writes revoked/version 3.
- Cleanup expires pending state, never expires a real active session, and recovers
  active-with-no-session only after the 120-second grace check.
- Boot lock secures the account before login services.
- Every secure path best-effort asks logind to disable guest linger, then removes
  and verifies `/var/lib/systemd/linger/guest` before terminating processes;
  inability to remove the marker is a local safety failure.
- After process termination, every secure path removes the exact guest runtime
  directory, guest-owned POSIX mqueues, guest-created/owned System V IPC, its
  persistent keyring, exact guest mailbox paths, and guest-owned entries on the
  three approved scratch mounts. PAM open recreates `/run/user/<guest UID>` empty
  with exact guest ownership and mode 0700. Keep this bounded; do not add a broad
  filesystem UID scan.
- Setup detects `pam_faillock.so`, `pam_tally2.so`, and `pam_tally.so` through the
  selected auth include graph and records the available reset commands root-only.
  Every issue enforces non-expiring guest aging and resets all detected counters
  before password rotation; any failure leaves the account locked.
- Persistent ordered outbox delivery uses a durable monotonic sequence and a
  short producer-only lock. It is independent from PAM, wall-clock time, and the
  worker lock held during network delivery.
- SSH denies `guest`; `provisioner` accepts only the two exact command shapes.
- Root-owned PAM rules for `passwd`, `chsh`, and `chfn` invoke a mode-0755 helper
  that denies non-root guest password/shell/GECOS changes while preserving root
  maintenance; the installer requires all three real PAM files.
- The selected GDM/LightDM/SDDM password stack rejects `pam_fprintd.so`, including
  through its validated auth include graph. Known alternate autologin,
  fingerprint, or smart-card paths are explicitly denied to `guest`; an unknown
  matching display-manager PAM path fails setup for review.
- Validate the complete global sudoers policy, then use sudo's resolved root-run
  list result in the C locale to prove `guest` has no command grant. Fail on any
  allow-list or ambiguous output; do not rely on a local deny line to override
  existing policy.
- Install the exact committed `00-labgate-deny-guest.rules` as `root:root 0644`
  only into an existing safe Polkit rules directory after proving Polkit is
  available. It returns `NO` for every action whose subject user is `guest` and
  has no branch for root, administrators, or `provisioner`. Compatibility cost:
  `guest` cannot perform any privileged desktop broker action.
- `provisioner` uses `/bin/sh`, a root-owned non-writable home with a
  provisioner-owned mode-0700 `.ssh` child, public-key-only authentication,
  `PermitUserEnvironment no`, locale-only `AcceptEnv`, and no forwarding/TTY/user
  startup file. The dispatcher resets its environment and invokes fixed
  root-owned `/usr/bin/sudo`.
- Keep the `provisioner` shadow password locked and deny that identity in the
  supported physical display-manager, `login`, and `su` PAM account paths while
  preserving its public-key forced-command SSH path.
- Bootstrap `provisioner` with verified `nologin`, a root-owned home, and no
  authorized key. Setup must first force `nologin`, terminate any old provisioner
  processes, install and validate sudoers/dispatcher/live ForceCommand, and only
  then expose `/bin/sh`. Install `authorized_keys` only after setup succeeds and
  prove arbitrary commands fail before accepting the endpoint.

**Done when:** syntax, sudoers, systemd, idempotency, version transitions,
deadline behavior, outbox ordering, boot recovery, and SSH restrictions pass in
fixtures and on the target Ubuntu host.

## Phase 6 — Versioned webhooks and heartbeat reconciliation

- Per-machine bearer tokens are stored in the database and root-only machine
  configuration, not environment variables or process arguments.
- Registration `POST` is immutable and idempotent only for the exact same
  canonical name/address/Ed25519-host-key-pin triple; a partial match returns conflict. New enrollment
  creates `offline` with null heartbeat. An exact replay returns the stable token
  without mutating status/heartbeat, and only a strict authenticated safe
  heartbeat may make the new endpoint available.
- The authenticated rekey `PATCH` is a deliberate drained compare-and-swap: it
  requires machine ID, exact expected identity and host-key pin, replacement
  identity and pin,
  `available` status, no current credential, and a null safety hold. Success
  atomically rotates the webhook token, clears heartbeat, and holds the row
  `offline`. The operator
  captures the token once into a root-only file, updates the endpoint, reruns
  setup, and waits for a locked/session-free heartbeat before release.
- Setup computes the local pin with `ssh-keygen -lf
  /etc/ssh/ssh_host_ed25519_key.pub -E sha256`, validates the exact canonical
  Ed25519 result, and persists it as root-only configuration. An existing token
  with no marker or a changed key fails before privileged policy changes. A
  legacy null database pin uses only the explicit drained PATCH CAS with
  `expectedSshHostKeySha256: null`; setup never silently claims it through POST.
- Session open accepts only version 2 for the exact generation.
- Session close and pending expiry accept only version 3.
- Heartbeats report generation ID, state, state version, session-active flag, and
  lock status as one consistent snapshot.
- A no-state heartbeat first completes the full local secure transaction and
  clears the PAM marker under the lifecycle lock. Failure withholds that
  release-capable heartbeat; corrupt local state is secured but never reported as
  safe no-state.
- Unknown, conflicting, contradictory, or stale reports hold the machine
  `occupied`; they terminalize any conflicting current DB row, persist the exact
  reported physical ID in the safety hold, and do not guess that it is safe.
- A fresh active heartbeat for a terminal DB generation creates the same hold.
  Only exact held-ID version 3 or a locked no-state heartbeat with no current row
  clears it; delayed closes for unrelated IDs never release.
- After transactionally recording them, transport-acknowledge every authenticated,
  well-formed lifecycle event of the endpoint's required version with 2xx. State
  disagreements use JSON `held`/`conflict`/`not_found`, including unknown open and
  unrelated terminal close; 4xx is only for auth, malformed input, or endpoint/
  version mismatch so the ordered outbox cannot head-of-line block a later close.

**Done when:** tests prove idempotency, monotonic ordering, wrong-generation
rejection, missed-webhook heartbeat reconciliation, and offline display after
the heartbeat window.

## Phase 7 — Confirmed-lock recovery sweep

- Sweep only credentials whose pending deadline passed and which never opened a
  session.
- A recently reachable machine must confirm exact-generation revoke over SSH
  before database release.
- A held machine is swept/reconciled against the exact held ID. An ambiguous
  provisioning row stays unrevoked and immediately expired until that retry
  confirms local lock; no other close clears the hold.
- An unreachable or stale-heartbeat machine remains occupied and is retried.
- An active credential remains occupied regardless of the original deadline.
- Invoke cron with a root-only curl configuration file; never place its bearer
  value in crontab, argv, logs, or shell history.

**Done when:** tests separately prove pending confirmed revoke, unreachable retry,
and active-after-deadline preservation.

## Phase 8 — Physical end-to-end validation

Follow the physical acceptance checks in `docs/recovery.md`
on a non-production physical Ubuntu or Arch-family desktop machine.
At minimum prove:

- exact password length and one-time display;
- pending version 1, active version 2, revoked version 3;
- successful physical login just before expiry continues after expiry;
- unused password fails after pending expiry;
- logout and next login use a fresh tmpfs;
- webhook outage retains ordered events while local safety still completes;
- power-cycle boot lock and stale-active recovery;
- guest SSH denial, provisioner command restriction, and administrator SSH;
- nologin-first/key-last provisioner bootstrap, supported/unknown display-manager
  PAM paths, fingerprint rejection, and guest `passwd`/`chsh`/`chfn` denial;
- drained identity rekey, old-token rejection, offline hold, safe-heartbeat
  release, Ed25519 host-key pin verification/rotation (including legacy-null
  CAS), and interrupted-rekey recovery without exposing tokens;
- non-expiring guest aging, PAM failure-counter reset, provisioner password/PAM
  denial, and bounded cleanup of runtime, IPC, keyring, mailbox, and scratch state;
- unexpected active/pending and terminal-active safety holds, unrelated-close
  rejection, ambiguous-provision retry, and exact-held-ID/no-state release;
- concurrent checkout and stale-generation protection.

Record commands, timestamps, redacted state, and pass/fail evidence. Do not check
Phase 8 in `PROGRESS.md` until every physical safety case passes.

## Documentation and deployment gate

- `README.md` explains the lifecycle without contradicting the runbooks.
- `docs/README.md` and the flat `docs/*.md` guides cover configuration,
  backup/preflight/migrations, commit-push-Pi-pull deployment, machine updates,
  PAM maintenance, recovery, state/outbox/log inspection, security checks, and
  rollback.
- physical acceptance is tracked through the operator guides and `PROGRESS.md`.
- Project changes are made and committed on the development machine, pushed,
  and then pulled with `git pull --ff-only` in `~/LabGate` on the Pi. Do not edit
  tracked project files directly on the Pi. Runtime configuration may be changed
  there with appropriate permissions.

**Done when:** all relative Markdown links resolve and searches find no old claim
that active sessions expire, stale heartbeats release machines, PAM performs
networking, passwords have a fixed fallback length, or `guest` can use SSH.
