# Progress — LabGate

Check off a phase only after its "done when" check in BUILD_PROMPT.md actually
passes. Add a one-line note for any deviation from the plan. If you're resuming
after a break — or you're a different agent picking this up — read this file
first. Don't redo a checked phase. Don't start a phase before the ones above it
are checked.

- [x] Phase 0 — Scaffold
- [x] Phase 1 — Database
- [x] Phase 2 — Auth
- [x] Phase 3 — Machine list + checkout API
- [x] Phase 4 — Provisioning module
- [x] Phase 5 — Machine-side scripts
- [x] Phase 6 — Webhooks + heartbeat
- [x] Phase 7 — Backstop sweep (server side)
- [ ] Phase 8 — End-to-end pass

## Phase 8 audit tracker

Confirmed lifecycle contract:

- `GUEST_PASSWORD_LENGTH` is the exact generated password length. Invalid
  configuration must fail clearly rather than silently select another length.
- `CREDENTIAL_TTL_HOURS` is a grace period for the first physical login, not a
  maximum desktop-session duration.
- Checkout reserves the machine immediately. If `guest` opens a session before
  the deadline, the machine remains occupied with no maximum duration until
  that session closes.
- If no session opens before the deadline, LabGate locks `guest`, revokes the
  credential, and releases the machine. The expired password must not work.

Tracking rules: keep an item unchecked until its behavior has direct test or
runtime evidence. Record commands/results in the evidence section below. Never
put passwords, OAuth values, webhook tokens, or other secrets in this file.

### Repository and deployment baseline

- [ ] Record local, origin, and Raspberry Pi commit IDs and confirm a clean
  local-first deployment path.
- [ ] Inventory the running Compose service, effective non-secret timeout and
  password-length settings, database location, sweep schedule, and recent
  errors without exposing secret values.
- [x] Inventory the physical lab machine's installed LabGate scripts, PAM
  integration, `guest` account state, timers, heartbeat, tmpfs state, and active
  sessions before making changes.

### Automated application validation

- [x] Add regression coverage proving configured password lengths (including
  `8`) are exact and invalid/missing values have intentional behavior.
- [x] Prove two concurrent checkouts for one available machine yield exactly one
  success and one `409` equivalent result.
- [x] Prove checkout marks the machine occupied and an unused, unexpired
  credential does not release it early.
- [x] Prove an unused expired credential is revoked only after a confirmed
  machine lock when the machine is reachable, then becomes available.
- [x] Prove `session-open` wins the expiry race: an active session remains
  occupied after the original credential deadline and is not force-revoked by
  the server sweep.
- [x] Prove `session-close` revokes the credential and returns the machine to
  available.
- [x] Prove webhook authentication, email-domain enforcement, SSH timeouts,
  provisioning rollback, offline derivation, and secret-safe responses/logging.
- [x] Pass Prisma validation/generation, unit/integration tests, lint, TypeScript,
  and a production build.

### Machine-side and live end-to-end validation

- [x] Audit shell syntax, argument validation, sudoers scope, permissions, and
  absence of forbidden per-student account creation/deletion commands.
- [ ] Run the installer twice and prove it is idempotent with no duplicate PAM
  entries or sudoers changes.
- [ ] Prove an issued password has the configured exact length and can log in
  before its deadline.
- [ ] Prove an unused password is locked after the grace period, cannot log in,
  releases the reservation, and a new checkout issues a different usable
  password.
- [ ] Prove PAM `open_session` remounts a fresh tmpfs on `/home/guest`, reports
  session-open best-effort, and leaves the machine occupied past the original
  credential deadline.
- [ ] Prove PAM `close_session` locks `guest`, unmounts the tmpfs, reports
  session-close best-effort, revokes the credential, and releases the machine.
- [x] Prove failed/slow webhooks cannot prevent local lock or unmount behavior.
- [ ] Prove the local systemd timer and Pi-side sweep independently recover the
  intended failure cases without terminating a genuinely active session.
- [ ] Prove heartbeat loss becomes offline within the documented window and
  recovery does not incorrectly advertise an unsafe machine as available.

### Delivery and operations documentation

- [x] Commit and push every project-file change locally before the Raspberry Pi
  pulls it; limit direct Pi edits to ignored environment/configuration data.
- [ ] Deploy the reviewed commit on the Pi and record post-deploy health and
  migration evidence.
- [x] Document configuration values and matching Pi/lab-machine timeout values,
  deployment/update/rollback, machine enrollment, PAM install/inspect/reset,
  manual session open/close validation, timers, recovery, logs, and
  troubleshooting in enough detail for a new operator.
- [ ] Complete the original Phase 8 physical flow and remove the outstanding
  blocker only after all required evidence is captured.

### Evidence

- 2026-07-14 local baseline: `main`, local HEAD and `origin/main` both
  `4e521a49ac7b4bdc718259b23370721443a265c9` before this audit change set. The
  Pi was previously observed at `66c3b72`; it is currently offline in Tailscale
  (`LastSeen=2026-07-13T19:49:12.1Z`) and SSH times out, so its current HEAD and
  deployment state cannot yet be re-confirmed.
- 2026-07-14 delivery: the reviewed implementation and documentation were
  committed locally as `a8102fbdde75bedb34ba11b2a450627a7d2e4abb` and pushed to
  `origin/main` before any tracked Pi file was changed. This tracker evidence is
  the only follow-up project-file change and is committed/pushed separately
  before the Pi is allowed to pull.
- 2026-07-14 physical-host inventory: the designated workstation is
  EndeavourOS rolling with SDDM, not the contract's Ubuntu Desktop/GDM target.
  Existing accounts are `guest` UID 950 and `provisioner` UID 951. Legacy
  cleanup/heartbeat units exist but their timers are inactive, there is no
  `/home/guest` mount or guest session, and a root RustDesk service is active.
  No privileged host mutation was performed during inventory.
- 2026-07-14 automated gates: `npm test` passed 85/85 Node tests and all 27
  rootless machine protocol tests; `npm run typecheck`, `npm run lint`,
  `git diff --check`, shell syntax checks, forbidden account-command checks,
  and `npm run build` passed. `npm audit --omit=dev` reported zero
  vulnerabilities.
- 2026-07-14 container gate: `labgate:audit-final` built successfully. From a
  blank private bind mount it applied all four migrations, passed database
  postflight, started as UID/GID 1000, created `/app/data` and the database with
  modes 0700/0600, returned health `200`, rejected unauthenticated machine data
  with `401`, and emitted the documented CSP, HSTS, anti-framing, and no-store
  headers.
- Regression coverage includes exact eight-character passwords and invalid
  configuration, atomic checkout conflict, pending expiry after confirmed lock,
  active-session survival past the login deadline, exact close/release,
  generation conflicts, token rekey races, Ed25519 host pinning, bounded request
  bodies, and fail-secure SSH compensation. Rootless machine coverage exercises
  PAM open/close failure paths, local pending expiry, outbox retry/order, boot
  recovery primitives, tmpfs cleanup, Polkit/sudo/SSH boundaries, and installer
  input validation without mutating this workstation.

## Notes / deviations

- Package manager changed from Bun to npm at the user's request; `AGENTS.md` and
  `BUILD_PROMPT.md` were updated to keep the project contract consistent.
- Restored the full `AGENTS.md` contract after `create-next-app` replaced it with
  generated Next.js guidance; that guidance is retained at the end of the file.
- Added `MACHINE_REGISTRATION_SECRET` so one-time machine enrollment is not a
  publicly callable token-minting endpoint.
- Changed the default credential lifetime to three minutes and made the local
  cleanup backstop lock issued credentials even when no PAM session was opened.
- Expired, unused reservations now require a confirmed guest-account lock before
  a healthy machine is released; the credential page shows the server expiry
  countdown, and guest password length is configurable with an 8-character
  default.

## Blockers

- The Raspberry Pi is offline in Tailscale and its SSH endpoint times out. The
  reviewed commit cannot be pulled/deployed, its database cannot be backed up or
  migrated, and live Compose/cron/health evidence cannot be refreshed until it
  returns.
- The designated physical workstation is EndeavourOS/SDDM rather than the
  Ubuntu Desktop/GDM production target. It has no passwordless sudo, so an
  operator must run the documented installer in a maintenance window and type
  the guest credential at the physical keyboard before live PAM assertions can
  be checked.
- A root RustDesk service is active on the physical workstation and conflicts
  with the physical-only deployment boundary. It has not been disabled because
  doing so changes an unrelated remote-access service and requires explicit
  operator authority.
