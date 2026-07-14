# AGENTS.md

## What this project is

A web app that lets students authenticate with Google (restricted to `@ubu.ac.th`),
reserve one of several shared **physical** Ubuntu Desktop lab machines, and receive a
temporary login for that machine. Students sit down and type the credentials at the
physical keyboard — this is not a remote/virtual desktop.

**Core design decision, read this before touching any machine-side code:** there is
exactly **one** shared OS account per machine, named `guest`. The web app never creates
or deletes Linux user accounts. Every "issuing a credential" is just a password
rotation + unlock on an account that already exists; every "revoking" is a lock. See
"Security invariants" below — most of them exist to protect this decision.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Web framework | Next.js 15+, App Router, TypeScript | |
| Auth | Better Auth | `socialProviders.google.hd` set to the allowed domain, **plus** a server-side email-suffix check (see invariant 5) |
| DB | SQLite + Prisma ORM | No Postgres/Mongo — scale doesn't need it |
| Provisioning transport | `node-ssh` (wraps `ssh2`) | Never shell out to the `ssh` binary |
| Machine mesh | Tailscale | Pi ↔ every lab machine; provisioning/webhook traffic never touches the public internet |
| Deployment | Docker Compose on Raspberry Pi 5 | Can reuse existing Jenkins pipeline if present |
| Machine-side | Bash + forced-command SSH + sudoers + PAM (`pam_exec`) + systemd | Lives in `machine-setup/`, not part of the Next.js app |

## Directory structure

```text
labgate/
├── AGENTS.md
├── BUILD_PROMPT.md
├── PROGRESS.md
├── README.md
├── docs/
│   ├── README.md
│   └── operations/
├── docker-compose.yml
├── .env.example
├── app/
│   ├── api/
│   │   ├── auth/[...all]/route.ts
│   │   ├── health/route.ts
│   │   ├── machines/route.ts
│   │   ├── checkout/route.ts
│   │   ├── cron/sweep/route.ts
│   │   ├── webhook/session-open/route.ts
│   │   ├── webhook/session-close/route.ts
│   │   ├── webhook/credential-expired/route.ts
│   │   ├── webhook/heartbeat/route.ts
│   │   └── admin/register-machine/route.ts
│   ├── (dashboard)/
│   └── layout.tsx
├── lib/
│   ├── auth.ts
│   ├── backstop.ts
│   ├── config.ts
│   ├── credential-id.ts
│   ├── credential-lifecycle.ts
│   ├── db/client.ts
│   ├── machine-report.ts
│   ├── provision.ts
│   ├── password.ts
│   ├── secure-bearer.ts
│   └── webhook-auth.ts
├── prisma/
│   ├── schema.prisma
│   └── migrations/
└── machine-setup/
    ├── 00-labgate-deny-guest.rules
    ├── install-machine.sh
    ├── labgate-common.sh
    ├── labgate-deny-guest-account-change.sh
    ├── labgate-guest.conf
    ├── labgate-provisioner.conf
    ├── labgate-provisioner-dispatch.sh
    ├── setup-machine.sh
    ├── guest-account.sh
    ├── guest-session-hook.sh
    ├── guest-cleanup.sh
    ├── guest-heartbeat.sh
    ├── guest-boot-lock.sh
    ├── guest-webhook-flush.sh
    ├── guest-boot-lock.service
    ├── guest-cleanup.service
    ├── guest-cleanup.timer
    ├── guest-heartbeat.service
    ├── guest-heartbeat.timer
    ├── guest-webhook-flush.service
    ├── guest-webhook-flush.timer
    ├── sshd-labgate-guest.conf
    └── sudoers-guest-provision
```

## Environment variables (`.env.example`)

```dotenv
BETTER_AUTH_URL=
BETTER_AUTH_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ALLOWED_EMAIL_DOMAIN=ubu.ac.th
DATABASE_URL=file:./data/labgate.db
PROVISIONER_SSH_KEY_PATH=/run/secrets/provisioner_key
CREDENTIAL_TTL_HOURS=0.05
GUEST_PASSWORD_LENGTH=8
MACHINE_REGISTRATION_SECRET=
CRON_SECRET=
```

`GUEST_PASSWORD_LENGTH` is exact, not a hint: generated passwords contain exactly
that many characters. Each machine's root-only `/etc/labgate/password-length` must
contain the same value; `setup-machine.sh` writes it from
`LABGATE_PASSWORD_LENGTH`. Both sides reject values outside 8–128.

`CREDENTIAL_TTL_HOURS` is only the deadline for entering the issued password at the
physical login screen. A credential that is still `pending` at the deadline is
locked and revoked. A credential that reached `active` before the deadline remains
active until the physical PAM session closes or fail-safe recovery confirms the
session is gone. There is no maximum duration for an active session unless you specify one.

`MACHINE_REGISTRATION_SECRET` and `CRON_SECRET` are 20–256-character RFC 6750
`b64token` values. Standard Base64 `+`, `/`, and terminal `=` padding are valid in
addition to the URL-safe characters; whitespace and quoting are not. Existing
URL-safe values remain valid and do not need rotation merely for compatibility.

Per-machine webhook tokens are **not** env vars — each machine gets its own random
token, generated and stored in the `machines` table at registration time, and written
to `/etc/labgate/webhook-token` on that machine by `setup-machine.sh`.

## Database schema (Prisma)

```text
machines
  id              pk
  name            text, unique
  tailscale_ip    text, unique
  ssh_host_key_sha256 text, unique, nullable only during the legacy migration
  webhook_token   text, unique
  status          enum('available','occupied','offline')
  last_heartbeat  timestamp, nullable
  safety_hold_credential_id text, nullable
  -- one exact unsafe generation, or a reserved conflict sentinel when multiple
  -- physical generations are implicated, held for reconciliation;
  -- not a foreign key because the physical ID may be unknown to the database.

guest_credentials
  id              pk
  machine_id      fk -> machines.id
  student_email   text
  created_at      timestamp
  expires_at      timestamp
  revoked_at      timestamp, nullable
  session_opened_at timestamp, nullable
  machine_state_version integer, default 0
  -- never a password column. see invariant 3.

audit_log
  id              pk
  machine_id      fk, nullable
  student_email   text, nullable
  event           enum('login','checkout','provision_ok','provision_fail',
                        'session_open','session_close','force_revoke',
                        'heartbeat_timeout','machine_rekey')
  detail          text, nullable
  created_at      timestamp
```

Better Auth's `User`, `Session`, `Account`, and `Verification` models are also in the
Prisma schema; the three models above are LabGate's domain models.

## Security invariants — do not violate these

1. Exactly one shared OS account per machine, named `guest`. **Never call
   `useradd`/`userdel`/`adduser`/`deluser` anywhere in this codebase.** If a task
   seems to need a new Linux user, stop and re-read this file — it doesn't.
2. Issuing a credential = rotating the `guest` password for one validated credential
   generation and persisting its login deadline. Revoking = locking that exact
   generation. No account is ever created or destroyed after initial machine setup.
3. The web app never stores a guest password anywhere — not hashed, not encrypted.
   It's returned once in the checkout API response body and then gone.
4. The password generator uses an unambiguous alnum charset only (exclude `0 O 1 l I`)
   and must never be able to produce shell metacharacters. Its output length must
   exactly equal `GUEST_PASSWORD_LENGTH`; the machine independently enforces the same
   exact length from `/etc/labgate/password-length`.
5. `hd` on the Google provider is necessary but not sufficient — always re-check
   `user.email.endsWith('@' + process.env.ALLOWED_EMAIL_DOMAIN)` server-side.
6. Any route that touches SSH must run on the Node.js runtime, never `edge`
   (`ssh2`/`node-ssh` need Node APIs).
7. The `provisioner` SSH identity is forced through
   `/usr/local/sbin/labgate-provisioner-dispatch.sh`; sudoers permits exactly the
   guest lifecycle script. The dispatcher accepts only the exact generation-scoped
   `issue` and `revoke` command shapes and invokes the root-owned regular
   `/usr/bin/sudo` path. The issue password is one newline-terminated line on SSH
   stdin; it is never part of `SSH_ORIGINAL_COMMAND` or any sudo/process argument.
   Both the dispatcher and root script require and validate exactly that one line.
   The identity uses `/bin/sh`, a root-owned non-writable
   home with a provisioner-owned `.ssh` child, public-key-only authentication,
   `PermitUserEnvironment no`, locale-only `AcceptEnv`, and no forwarding/TTY/user
   startup file. On first install, create it with a verified `nologin` shell and no
   authorized key. Its password stays locked, and physical display-manager,
   `login`, and `su` PAM account paths deny `provisioner` without denying its
   public-key forced-command SSH path. Setup kills old provisioner processes and exposes `/bin/sh` only
   after the dispatcher, sudoers, and live forced-command policy pass validation;
   install the public key only after setup completes. Widening any layer is a
   security review, not a feature PR.
8. `guest-account.sh` re-validates the credential ID, future Unix deadline, the
   application maximum of 24 hours plus only 60 seconds of clock-skew allowance,
   password stdin framing, charset, and exact configured password length even though the
   caller and SSH dispatcher already did — every layer distrusts the one above it.
   Before every unlock it enforces non-expiring guest password aging and resets
   every failure-counter backend discovered in the selected PAM auth include graph
   (`pam_faillock`, `pam_tally2`, or `pam_tally`); reset ambiguity keeps `guest` locked.
9. Checkout is a single atomic conditional update requiring the machine ID,
   `status='available'`, a recent heartbeat, and
   `safety_hold_credential_id IS NULL`, checking affected-row count. Never
   read-then-write and never claim a held machine.
10. Every provisioning call has an explicit timeout. On failure, attempt an
    exact-generation compensating revoke. Mark the row revoked and return the
    machine to `available` only when that local lock is confirmed; otherwise keep
    the row unrevoked with an immediate expiry, persist its exact ID as the safety
    hold, and keep the machine `occupied` so the sweep retries that same SSH
    revoke. Only confirmed lock terminalizes/releases it. A student must never see
    a password for a machine that failed to provision.
11. PAM hooks fail open toward *security*, not availability. They never perform a
    network call. They complete the local mount or lock/process-termination/unmount
    transaction first and append a versioned event to the persistent outbox. A
    separate timer retries delivery in order. Outbox order comes from a persistent
    monotonic sequence allocated under its own short local lock, never wall-clock
    time. Producers must never acquire the worker lock that can be held across
    network I/O.
12. `/home/guest` is remounted as tmpfs on every `open_session`, not only cleared on
    `close_session` — that's the actual guarantee, not an assumption that close always runs.
    Secure close/recovery also removes `/run/user/<guest UID>`, guest-owned POSIX
    mqueues, guest-created/owned System V IPC, the guest persistent keyring, exact
    `guest` mailboxes under `/var/mail` and `/var/spool/mail`, and guest-owned entries
    on `/tmp`, `/var/tmp`, and `/dev/shm`. PAM open recreates an empty mode-0700
    runtime directory. These are deliberately bounded paths; never replace them
    with an unreviewed filesystem-wide UID scan.
13. The cleanup, heartbeat, webhook-flush, and boot-lock systemd units are required,
    not optional. Boot recovery must lock, terminate guest-owned processes, and
    unmount the guest home before display-manager or SSH login services start.
14. The credential deadline applies only while machine state is `pending`. An active
    physical session ignores the original deadline and keeps the machine `occupied`.
    There is no maximum duration for an active session unless you specify one.
15. Machine lifecycle reports are generation-scoped and monotonic:
    `pending = stateVersion 1`, `active = stateVersion 2`, and
    `revoked = stateVersion 3`. A delayed event for an older generation or lower
    version must never reopen or release a newer reservation.
    Terminal generation tombstones are persistent: an ID revoked after a failed
    or completed issue must never be issuable again.
16. A machine returns to `available` only after the exact generation is confirmed
    revoked with `guest` locked and no active physical session. Expiry, an unreachable
    host, or a stale heartbeat alone is not proof of safety; keep the machine
    `occupied` and retry/reconcile.
17. The shared `guest` account is physical-desktop-only and is denied SSH access.
    The `provisioner` identity has no general shell, forwarding, tunnel, agent, X11,
    or TTY capability. Preserve administrator SSH access when changing this policy.
18. Persistent machine state and queued outbox events contain credential IDs,
    deadlines, states, and versions, but never a guest password or bearer token.
    Bearer credentials live only in root-controlled configuration files and must not
    be exposed in process arguments or logs. Never reset or delete the persistent
    outbox sequence during routine recovery; gaps are valid after interrupted
    publication.
19. Production startup validates every runtime configuration boundary before
    migration, including a readable non-empty regular absolute provisioning-key
    path with mode `0600` and 20–256-character RFC 6750 `b64token`
    registration/cron secrets. It
    fails closed for duplicate/non-canonical machine identity, duplicate
    current credentials, `available` plus current-credential drift, or
    `available` plus a non-null safety hold. An
    `occupied` machine with no current credential remains quarantined and emits an
    operator warning; startup must not silently make it available.
20. Machine registration `POST` is immutable: one canonical Tailscale CGNAT IPv4
    address, one name, and one canonical `SHA256:` Ed25519 SSH host-key fingerprint
    identify one physical endpoint. A new row starts
    `offline` with `last_heartbeat = NULL`; only an authenticated, internally
    consistent locked/session-free heartbeat may make it available. Only the exact
    same triple is idempotent: it returns the stable token without changing status,
    heartbeat, identity, or any other machine state. Identity or token change uses only the authenticated,
    drained `PATCH` compare-and-swap workflow: machine ID and exact expected
    identity must match, status must be `available`, no current credential may
    exist, and the safety hold must be null. It atomically installs the replacement
    identity/token, clears heartbeat, and holds the machine `offline`. The replacement token is handled as a one-time
    secret, installed root-only, and the endpoint remains unavailable until the new
    token reports a locked, session-free safe heartbeat.
    Setup derives the pin from `/etc/ssh/ssh_host_ed25519_key.pub` with
    `ssh-keygen -lf ... -E sha256`, stores the non-secret exact value root-only in
    `/etc/labgate/ssh-host-key-sha256`, and refuses an existing token without that
    marker or with a changed key. A legacy database null pin is claimed only by the
    explicit drained `PATCH` CAS using `expectedSshHostKeySha256: null`; setup never
    silently POSTs or rekeys it.
21. The shared guest must not persistently change its password, login shell, or
    GECOS data. Root-owned PAM rules for `passwd`, `chsh`, and `chfn` call the
    mode-0755 `labgate-deny-guest-account-change.sh` helper without `seteuid`; it
    denies non-root changes for `guest` while preserving explicit root maintenance.
22. The selected display-manager PAM stack must be one of the installer-supported
    password stacks and must not contain `pam_fprintd.so`, including through its
    validated auth include graph. Known GDM, LightDM, and SDDM alternate login paths
    are explicitly denied to `guest`; an unknown matching display-manager PAM path
    fails setup and keeps the endpoint out of service pending review.
23. `machines.safety_hold_credential_id` persists the exact physical generation
    that made server state ambiguous. An unexpected active/pending report
    terminalizes every current DB row, records the reported ID as the hold, and
    keeps the machine `occupied`; a fresh active heartbeat for an already-terminal
    row does the same. A terminal report for another ID must never release it.
    Clear/release only after locked version 3 for the held ID, or a genuinely
    locked no-state heartbeat with no current DB credential. Never delete or
    overwrite a hold as an administrative shortcut. The reserved internal marker
    represents an unsafe unlocked report that supplied no physical ID. Before the
    endpoint emits any release-capable no-state heartbeat, it must successfully
    run the complete secure transaction under the lifecycle lock and clear the PAM
    marker. A corrupt state is also secured but is never serialized as safe
    no-state; secure failure records recovery and withholds the heartbeat.
24. The committed `00-labgate-deny-guest.rules` is a universal Polkit deny for
    `subject.user === "guest"` and must return `polkit.Result.NO` for every action.
    Setup requires an existing root-controlled Polkit rules directory, installs
    and byte-compares that exact artifact as `root:root 0644`, and must not affect
    root, administrator, or `provisioner` subjects. This intentionally means the
    shared guest loses every privileged desktop broker action. Every local secure
    path best-effort disables guest linger, removes and verifies
    `/var/lib/systemd/linger/guest` before process cleanup, and treats persistence
    of that marker as a safety failure.
25. Enrollment fails closed unless the resolved global sudo policy proves that
    `guest` has no command grant. Validate all sudoers includes first, then query
    effective policy as root in the C locale; do not add a deny entry and assume
    it overrides an existing grant. Root, administrator, and the separately
    constrained `provisioner` sudo boundary remain unaffected.
26. Every authenticated, syntactically valid lifecycle event with the endpoint's
    required state version is transactionally recorded and transport-acknowledged
    with 2xx, even when its JSON result is `held`, `conflict`, or `not_found`.
    This includes unknown/conflicting open and unrelated/unknown terminal close.
    Reserve 4xx for authentication, malformed input, or endpoint/version mismatch;
    otherwise a persistent ordered outbox could poison at its head and prevent the
    exact later terminal event from advancing reconciliation.
27. Machine setup accepts `LABGATE_API_URL` only as an origin: lowercase `http` or
    `https`, one canonical DNS hostname or IPv4 address, and an optional canonical
    decimal port 1–65535. Userinfo, paths (including `/`), query, fragment, IPv6,
    non-canonical IPv4/hostname text, whitespace, and defaulting are rejected; the
    installed sender re-validates the same grammar. If no existing token plus
    matching host-pin marker exists, setup validates the required registration
    bearer before any guest/provisioner account, PAM, or SSH mutation. The network
    helper validates it again immediately before POST.

## Non-goals (don't add without discussion)

- Per-student OS accounts of any kind
- Postgres/Mongo, or any DB beyond SQLite
- Containerized or remote-desktop guest sessions — this is a physical lab
- Directory services (FreeIPA/SSSD) — out of scope for this build

## Conventions

- TypeScript strict mode, no `any` in `lib/`
- Server Components by default; Client Components only where interactivity requires it
- All DB access through Prisma Client, no raw SQL except in migrations
- Package manager: npm

## Commands

```text
npm install
npm run dev
npm run build
npx prisma generate
npx prisma migrate dev
```

Production deployment, machine recovery, PAM maintenance, rollback, and physical
acceptance procedures live in the routed guides under [docs/README.md](docs/README.md).

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all
differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/`
before writing Next.js code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
