# Build prompt — LabGate

Paste this whole file as the first task to your coding agent (OpenCode/Codex/Claude
Code). Read `AGENTS.md` first — it's the contract for this project. The security
invariants in it are not suggestions; treat them the same as failing tests.

Work through the phases in order. Each phase has a "done when" check — don't move on
until it's true. Commit after each phase.

---

## Step 0 — Initialize the progress tracker

Before touching any code, create `PROGRESS.md` at the repo root:

```markdown
# Progress — LabGate

Check off a phase only after its "done when" check in BUILD_PROMPT.md actually
passes. Add a one-line note for any deviation from the plan. If you're resuming
after a break — or you're a different agent picking this up — read this file
first. Don't redo a checked phase. Don't start a phase before the ones above it
are checked.

- [ ] Phase 0 — Scaffold
- [ ] Phase 1 — Database
- [ ] Phase 2 — Auth
- [ ] Phase 3 — Machine list + checkout API
- [ ] Phase 4 — Provisioning module
- [ ] Phase 5 — Machine-side scripts
- [ ] Phase 6 — Webhooks + heartbeat
- [ ] Phase 7 — Backstop sweep (server side)
- [ ] Phase 8 — End-to-end pass

## Notes / deviations

## Blockers
```

Commit it. From here on, check the corresponding box and commit `PROGRESS.md` in
the **same commit** as each phase's code — not batched at the end. If a phase
surfaces a blocker (e.g. no real lab machine to test against yet), log it under
"Blockers" rather than silently skipping ahead.

---

## Phase 0 — Scaffold

- `npx create-next-app@latest` (TypeScript, App Router, Tailwind, no `src/` dir)
- Install: `better-auth`, `prisma`, `@prisma/client`, `node-ssh`
- Copy `.env.example` → `.env.local`, fill in placeholder values
- Set up `docker-compose.yml` for the Pi (single service, mount `./data` for the
  SQLite file, mount the provisioner private key as a secret/volume — never bake it
  into the image)

**Done when:** `npm run dev` runs, empty homepage loads.

## Phase 1 — Database

- Write `prisma/schema.prisma` matching the schema in AGENTS.md exactly (3 models)
- Run `npx prisma migrate dev --name init`
- Write a tiny seed script (`prisma db seed`) that inserts one fake `machines` row
  for local dev

**Done when:** `npx prisma studio` shows all 3 tables with correct types/enums.

## Phase 2 — Auth

- Configure Better Auth with `socialProviders.google`, including `hd:
  process.env.ALLOWED_EMAIL_DOMAIN`
- Add a server-side hook/callback that independently checks
  `user.email.endsWith('@' + process.env.ALLOWED_EMAIL_DOMAIN)` and rejects sign-in
  if not — this must not depend on the `hd` claim being present (invariant 5)
- Wire up the client sign-in button and a protected layout that redirects
  unauthenticated users to login

**Done when:** signing in with a non-`ubu.ac.th` Google account is rejected server-side
even if you locally forge/strip the `hd` param on the request.

## Phase 3 — Machine list + checkout API

- `GET /api/machines`: list machines, derive `offline` display state from
  `last_heartbeat` being older than ~2 minutes (don't just trust the stored `status`)
- `POST /api/checkout { machineId }`:
  1. require an authenticated `@ubu.ac.th` session
  2. reject if this email already has a non-revoked, non-expired credential elsewhere
  3. atomic `UPDATE machines SET status='occupied' WHERE id=? AND status='available'`
     — if 0 rows affected, return 409 (invariant 9)
  4. generate password (`lib/password.ts`, charset per invariant 4)
  5. insert `guest_credentials` row (no password column, invariant 3)
  6. call `provisionMachine()` (Phase 4) — on failure, roll status back to
     `available` and set `revoked_at` on the row you just inserted (invariant 10)
  7. on success, return `{ username: 'guest', password, expiresAt }` in the response
     body only — this is the only place the password ever exists in this app
- Write the machine-picker UI page

**Done when:** two rapid concurrent checkout requests for the same machine result in
exactly one success and one 409, verified with a quick script or test, not just by
eyeballing it.

## Phase 4 — Provisioning module

- `lib/provision.ts`: `node-ssh`, Node runtime only, explicit connect timeout
  (~5s), runs `sudo /usr/local/sbin/guest-account.sh issue <password>` for issue and
  `... revoke` for revoke, throws on non-zero exit
- Never construct this command with untrusted input beyond the already-validated
  password (invariant 4/8)

**Done when:** calling `provisionMachine()` against a real (or locally Dockerized
SSH) test host actually rotates a password there.

## Phase 5 — Machine-side scripts (`machine-setup/`)

These are bash/systemd/PAM, not Next.js — write them as plain files, no build step.

- `guest-account.sh` (root, `chmod 700`): `issue <password>` / `revoke`, re-validates
  its own arguments (charset regex on the password, exact match on the action) before
  doing anything (invariant 8)
- `sudoers-guest-provision`: one line, `provisioner ALL=(root) NOPASSWD:
  /usr/local/sbin/guest-account.sh`, installed to `/etc/sudoers.d/`
- `guest-session-hook.sh`: reads `PAM_TYPE`/`PAM_USER`; on `open_session`, mounts
  `tmpfs` over `/home/guest` (uid/gid `guest`, size ~512M) then best-effort POSTs to
  the session-open webhook; on `close_session`, lazy-unmounts, locks the account
  (`passwd -l guest`), then best-effort POSTs to session-close. Webhook calls use a
  short curl timeout and `|| true` so they can never block/fail the PAM transaction
  (invariant 11)
- PAM config: append (don't duplicate on reruns) a line invoking
  `pam_exec.so /usr/local/sbin/guest-session-hook.sh` to the target display manager's
  session stack — do **not** use the `seteuid` option, the hook needs root
- `guest-cleanup.sh` + `.service` + `.timer`: every ~1 minute, lock an issued
  credential past its five-minute max-TTL even if no PAM session was opened; if
  `/home/guest` is mounted, force-unmount it too (invariant 13, this is the
  backstop, keep it independent of the webhook path)
- `setup-machine.sh`: idempotent top-to-bottom installer — creates+locks `guest` if
  missing, installs the above files, joins Tailscale, calls
  `POST /api/admin/register-machine` to get a webhook token, writes
  `/etc/labgate/{webhook-token,api-url}`

**Done when:** running `setup-machine.sh` twice in a row on the same box produces no
errors and no duplicate PAM lines/sudoers entries.

## Phase 6 — Webhooks + heartbeat

- `POST /api/webhook/session-open` and `.../session-close`: authenticate via the
  per-machine token (`Authorization: Bearer <token>`, matched against
  `machines.webhook_token`), update `machines.status` and write `audit_log`
- Add a heartbeat mechanism (either the hook scripts also ping periodically, or a
  small separate systemd timer) that updates `last_heartbeat`

**Done when:** unplugging a machine's network causes it to show as offline within ~2
minutes on the dashboard without any manual DB edit.

## Phase 7 — Backstop sweep (server side)

- A scheduled job (cron container, or a route hit by an external cron) that finds
  `guest_credentials` past `expires_at` with no `revoked_at` and no recent webhook
  activity, and marks the machine `available` again — this is the "machine died
  completely" case that even the local systemd timer can't fix

**Done when:** manually expiring a credential's `expires_at` in the DB (with the
machine simulated as unreachable) results in it becoming available again within one
sweep interval.

## Phase 8 — End-to-end pass

Walk the full flow from the earlier design doc once, for real, on one real or VM lab
machine: login → checkout → SSH provision → type credentials at the login screen →
use the desktop → log out → confirm `guest` is locked and `/home/guest` is a fresh
tmpfs on next login. Then kill the VM mid-session and confirm the systemd + server
backstops both independently recover it.

---

If you want to split this across parallel sub-agents instead of one linear run, Phases
0–3+6–7 (the Next.js app) and Phase 5 (machine-side bash/PAM/systemd) have almost no
file overlap and can run as two agents against the same `AGENTS.md`, converging at
Phase 8.
