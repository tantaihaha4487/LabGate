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
- [ ] Inventory the physical lab machine's installed LabGate scripts, PAM
  integration, `guest` account state, timers, heartbeat, tmpfs state, and active
  sessions before making changes.

### Automated application validation

- [ ] Add regression coverage proving configured password lengths (including
  `8`) are exact and invalid/missing values have intentional behavior.
- [ ] Prove two concurrent checkouts for one available machine yield exactly one
  success and one `409` equivalent result.
- [ ] Prove checkout marks the machine occupied and an unused, unexpired
  credential does not release it early.
- [ ] Prove an unused expired credential is revoked only after a confirmed
  machine lock when the machine is reachable, then becomes available.
- [ ] Prove `session-open` wins the expiry race: an active session remains
  occupied after the original credential deadline and is not force-revoked by
  the server sweep.
- [ ] Prove `session-close` revokes the credential and returns the machine to
  available.
- [ ] Prove webhook authentication, email-domain enforcement, SSH timeouts,
  provisioning rollback, offline derivation, and secret-safe responses/logging.
- [ ] Pass Prisma validation/generation, unit/integration tests, lint, TypeScript,
  and a production build.

### Machine-side and live end-to-end validation

- [ ] Audit shell syntax, argument validation, sudoers scope, permissions, and
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
- [ ] Prove failed/slow webhooks cannot prevent local lock or unmount behavior.
- [ ] Prove the local systemd timer and Pi-side sweep independently recover the
  intended failure cases without terminating a genuinely active session.
- [ ] Prove heartbeat loss becomes offline within the documented window and
  recovery does not incorrectly advertise an unsafe machine as available.

### Delivery and operations documentation

- [ ] Commit and push every project-file change locally before the Raspberry Pi
  pulls it; limit direct Pi edits to ignored environment/configuration data.
- [ ] Deploy the reviewed commit on the Pi and record post-deploy health and
  migration evidence.
- [ ] Document configuration values and matching Pi/lab-machine timeout values,
  deployment/update/rollback, machine enrollment, PAM install/inspect/reset,
  manual session open/close validation, timers, recovery, logs, and
  troubleshooting in enough detail for a new operator.
- [ ] Complete the original Phase 8 physical flow and remove the outstanding
  blocker only after all required evidence is captured.

### Evidence

- Pending baseline audit.

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

- The previously recorded lack of a physical test machine is being re-evaluated:
  the current workstation is now designated as the lab machine. Phase 8 remains
  open until access, display-manager behavior, and the full physical flow are
  verified safely.
