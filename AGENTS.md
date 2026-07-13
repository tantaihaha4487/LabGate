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
| Machine-side | Bash + sudoers + PAM (`pam_exec`) + systemd timer | Lives in `machine-setup/`, not part of the Next.js app |

## Directory structure

```text
labgate/
├── AGENTS.md
├── BUILD_PROMPT.md
├── PROGRESS.md
├── docker-compose.yml
├── .env.example
├── app/
│   ├── api/
│   │   ├── auth/[...all]/route.ts
│   │   ├── machines/route.ts
│   │   ├── checkout/route.ts
│   │   ├── webhook/session-open/route.ts
│   │   ├── webhook/session-close/route.ts
│   │   └── admin/register-machine/route.ts
│   ├── (dashboard)/
│   └── layout.tsx
├── lib/
│   ├── auth.ts
│   ├── db/client.ts
│   ├── provision.ts
│   ├── password.ts
│   └── webhook-auth.ts
├── prisma/
│   ├── schema.prisma
│   └── migrations/
└── machine-setup/
    ├── setup-machine.sh
    ├── guest-account.sh
    ├── guest-session-hook.sh
    ├── guest-cleanup.sh
    ├── guest-cleanup.service
    ├── guest-cleanup.timer
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
CREDENTIAL_TTL_HOURS=3
MACHINE_REGISTRATION_SECRET=
CRON_SECRET=
```

Per-machine webhook tokens are **not** env vars — each machine gets its own random
token, generated and stored in the `machines` table at registration time, and written
to `/etc/labgate/webhook-token` on that machine by `setup-machine.sh`.

## Database schema (Prisma)

```text
machines
  id              pk
  name            text
  tailscale_ip    text
  webhook_token   text, unique
  status          enum('available','occupied','offline')
  last_heartbeat  timestamp, nullable

guest_credentials
  id              pk
  machine_id      fk -> machines.id
  student_email   text
  created_at      timestamp
  expires_at      timestamp
  revoked_at      timestamp, nullable
  -- never a password column. see invariant 3.

audit_log
  id              pk
  machine_id      fk, nullable
  student_email   text, nullable
  event           enum('login','checkout','provision_ok','provision_fail',
                        'session_open','session_close','force_revoke','heartbeat_timeout')
  detail          text, nullable
  created_at      timestamp
```

Better Auth's `User`, `Session`, `Account`, and `Verification` models are also in the
Prisma schema; the three models above are LabGate's domain models.

## Security invariants — do not violate these

1. Exactly one shared OS account per machine, named `guest`. **Never call
   `useradd`/`userdel`/`adduser`/`deluser` anywhere in this codebase.** If a task
   seems to need a new Linux user, stop and re-read this file — it doesn't.
2. Issuing a credential = rotating the `guest` password. Revoking = `passwd -l guest`.
   No account is ever created or destroyed after initial machine setup.
3. The web app never stores a guest password anywhere — not hashed, not encrypted.
   It's returned once in the checkout API response body and then gone.
4. The password generator uses an unambiguous alnum charset only (exclude `0 O 1 l I`)
   and must never be able to produce shell metacharacters — it gets interpolated into
   a remote command.
5. `hd` on the Google provider is necessary but not sufficient — always re-check
   `user.email.endsWith('@' + process.env.ALLOWED_EMAIL_DOMAIN)` server-side.
6. Any route that touches SSH must run on the Node.js runtime, never `edge`
   (`ssh2`/`node-ssh` need Node APIs).
7. The `provisioner` SSH key is scoped by `sudoers` to run exactly one script and
   nothing else. Widening what that script can do is a security review, not a feature PR.
8. `guest-account.sh` re-validates its own arguments even though the caller already
   did — every layer distrusts the one above it.
9. Checkout is a single atomic `UPDATE machines SET status='occupied' WHERE id=? AND
   status='available'`, checking affected-row count. Never read-then-write.
10. Every provisioning call has an explicit timeout. On failure, roll the machine
    back to `available` and revoke the credential row. A student must never see a
    password for a machine that failed to provision.
11. PAM hooks fail open toward *security*, not availability: if the webhook call
    fails or times out, the local lock/unmount still happens. Webhook calls are
    best-effort and must never block or fail the PAM transaction.
12. `/home/guest` is remounted as tmpfs on every `open_session`, not only cleared on
    `close_session` — that's the actual guarantee, not an assumption that close always runs.
13. The systemd timer backstop is required, not optional. PAM hooks can fail to fire
    (power loss, kernel panic) — test the backstop as seriously as the happy path.

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

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all
differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/`
before writing Next.js code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
