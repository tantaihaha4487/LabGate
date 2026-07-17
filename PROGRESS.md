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

## Admin dashboard tracker

- [x] Require and validate exact-domain `ADMIN_EMAILS` configuration at
  runtime and production preflight without storing administrator roles in SQLite.
- [x] Add the visibility migration, database postflight checks, independently
  authorized page/APIs, secret-safe machine inventory, and idempotent audited
  hide/restore mutations.
- [x] Keep hidden machines managed while filtering student listings and the
  atomic checkout claim; preserve reservations, lifecycle status, heartbeats,
  safety holds, and registration/rekey behavior.
- [x] Add the 15-second admin dashboard refresh, configured-admin list,
  replacement-line generator, Pi instructions, and focused automated coverage.
- [ ] Configure `ADMIN_EMAILS` on the Pi before deploying the image, then
  complete signed-out, institutional non-admin, and configured-admin manual
  hide/restore acceptance. This does not mark Phase 8 complete.

## Admin login/logout/password-timeout activity tracker

- [x] Add the durable `logout` and attributable `password_timeout` audit events,
  stable `(created_at, id)` activity index, migration coverage, and database
  postflight enforcement.
- [x] Record exactly one attributable web logout after successful Better Auth
  session deletion without duplicating repeated sign-out attempts.
- [x] Add an independently authorized, no-store `/api/admin/logs` endpoint with
  secret-safe web/physical mapping, filters, and opaque cursor pagination.
- [x] Add the independently authorized `/admin/logs` interface, admin-only
  navigation, 50-row UTC display, filters, manual refresh, and Older/Newer
  controls.
- [x] Pass focused activity tests, clean and upgraded migration checks, Prisma
  validation/generation, the full test suite, TypeScript, lint, production
  build, and diff checks.
- [ ] Manually confirm web and physical login/logout activity after deployment.
  This does not mark Phase 8 complete.

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
- [x] Add and validate distro-aware one-shot dependency bootstrap for Ubuntu
  Desktop and Arch-family desktops, including EndeavourOS with SDDM.
- [x] Prove the colorized one-shot installer contract with automated coverage:
  forced/automatic/plain output, secret-safe live child rendering, eight ordered
  stages, key-last publication, distro-specific summaries, and safe success or
  failure operator actions; pass the full repository and shell validation gate.
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

- 2026-07-15 admin dashboard gate: Prisma validation/generation and all five
  migrations passed; `npm test` passed 105/105 Node tests, all 27 rootless
  machine protocol tests, and uninstall checks. TypeScript, lint, diff checks,
  and the production build passed with `/admin` plus both admin machine routes
  emitted as dynamic server routes. Pi configuration/deployment and manual
  admin/non-admin hide/restore acceptance remain outstanding, so Phase 8 stays
  unchecked.
- 2026-07-14 local baseline: `main`, local HEAD and `origin/main` both
  `4e521a49ac7b4bdc718259b23370721443a265c9` before this audit change set. The
  Pi was previously observed at `66c3b72`; it is currently offline in Tailscale
  (`LastSeen=2026-07-13T19:49:12.1Z`) and SSH times out, so its current HEAD and
  deployment state cannot yet be re-confirmed.
- 2026-07-14 delivery: the reviewed implementation and documentation were
  committed locally as `a8102fbc1772e311212bd0afc287f46ce9ef0f00` and pushed to
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
- 2026-07-14 one-shot enrollment gate: the interactive installer and Pi
  enrollment-protocol v1 readiness check raised the Node suite to 92/92 while
  all 27 rootless machine protocol tests and the uninstall-script checks still
  passed. `npm run typecheck`, `npm run lint`, and `npm run build` also passed.
  Tests prove dry-run redaction, immutable source selection, read-only
  registration readiness, Pi checks before local identity changes, and
  provisioner-key publication only after hardened setup. No live Ubuntu
  Desktop enrollment was performed, so Phase 8 remains unchecked.
- 2026-07-14 live SSH-policy compatibility: EndeavourOS OpenSSH rejected
  `PermitUserEnvironment` inside the constrained `Match User provisioner`
  block and the installer restored the prior SSH configuration. The reviewed
  fix places the same `PermitUserEnvironment no` restriction in the global
  root-owned LabGate drop-in and keeps effective-policy verification for the
  provisioner. The focused 27-case rootless machine suite, lint, TypeScript,
  shell syntax, and diff checks pass; live installation remains in progress.
- 2026-07-14 live setup retry reached the late root-only webhook curl-config
  installation and exposed a Bash dynamic-scope collision between the caller's
  `temporary` variable and `new_temporary_file`. The reviewed caller now uses a
  distinct descriptive name with a static regression assertion. The partial
  run remained fail-secure: boot lock was active and the provisioner shell was
  enabled only after the forced-command SSH policy passed validation.
- 2026-07-14 container gate: `labgate:audit-final` built successfully. From a
  blank private bind mount it applied all four migrations, passed database
  postflight, started as UID/GID 1000, created `/app/data` and the database with
  modes 0700/0600, returned health `200`, rejected unauthenticated machine data
  with `401`, and emitted the documented CSP, HSTS, anti-framing, and no-store
  headers.
- 2026-07-16 Arch bootstrap: the one-shot installer classifies exact Arch and
  `ID_LIKE=arch` hosts, installs only missing fixed prerequisites with
  `pacman -S --needed`, and never performs a full system upgrade. A local dry run on
  EndeavourOS/SDDM selected the Arch branch and redacted supplied secrets.
  `npm test` passed 94/94 Node tests, all 27 private-namespace machine tests,
  and the uninstall checks; lint, typecheck, Bash syntax, and diff checks also
  passed. The live package/install mutation and twice-run idempotency gate remain
  unchecked.
- 2026-07-15 colorized installer gate: forced, automatic, `NO_COLOR`,
  `TERM=dumb`, and plain output tests cover per-stream styles, resets, prompt
  validation, live child-output sanitization/redaction, exit-status preservation,
  eight ordered stages, key-last ordering, and safe success/failure actions.
  `npm test` passed 105/105 Node tests, all 27 private-namespace machine tests,
  and uninstall-script tests; `npm run typecheck`, `npm run lint`,
  `npm run build`, Bash syntax, forbidden account-command scanning, committed
  and worktree `git diff --check` gates passed. The live twice-run installer and
  physical acceptance items remain unchecked.
- 2026-07-16 installer safety and password-boundary fix: validated interactive
  prompts now preserve entered values, guest password lengths 5-128 are accepted
  consistently by the app and machine, and Arch enrollment installs only missing
  prerequisites with `pacman -S --needed` instead of a full system upgrade.
  `npm test` passed 105/105 Node tests, all 27 private-namespace machine tests,
  and uninstall-script tests; typecheck, lint, build, Bash syntax, and diff
  checks passed. The current host had no LabGate `pacman` process left running.
- 2026-07-16 logout blank-screen regression fix: display-manager PAM integration
  now installs an `open_session` hook before the normal stack and a
  `close_session` hook after `pam_systemd`, while removing both prior single-hook
  spellings. This keeps logind teardown ahead of synchronous guest cleanup;
  `npm test` passed 105/105 Node tests, all 27 private-namespace machine tests,
  and uninstall-script tests, with Bash syntax and diff checks passing. Physical
  SDDM logout verification remains unchecked.
- 2026-07-16 activity logging gate: Added the Better Auth session-delete logout
  hook, attributable pending-password timeout activity, indexed newest-first
  admin API/page, strict filters/cursors, and no-store secret-safe responses.
  Clean and upgraded migration checks, missing-index postflight rejection,
  logout idempotency, timeout mapping, filtering, deterministic pagination,
  `npm test` (110 Node tests, 27 machine tests, uninstall checks), Prisma
  validation/generation, TypeScript, lint, production build, and diff checks
  passed. Manual deployed web/physical activity confirmation remains open.
- Regression coverage includes exact default eight-character and minimum
  five-character passwords plus invalid configuration, atomic checkout conflict,
  active-session survival past the login deadline, exact close/release,
  generation conflicts, token rekey races, Ed25519 host pinning, bounded request
  bodies, and fail-secure SSH compensation. Rootless machine coverage exercises
  PAM open/close failure paths, local pending expiry, outbox retry/order, boot
  recovery primitives, tmpfs cleanup, Polkit/sudo/SSH boundaries, and installer
  input validation without mutating this workstation.

## Notes / deviations

- Package manager changed from Bun to npm at the user's request; `AGENTS.md` and
  `BUILD_PROMPT.md` were updated to keep the project contract consistent.
- Physical endpoint support expanded from Ubuntu Desktop to Ubuntu plus
  Arch-family desktops at the user's request; Arch installation performs a full
  package upgrade rather than creating an unsupported partial-upgrade state.
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
