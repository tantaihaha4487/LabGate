# LabGate

LabGate lets `@ubu.ac.th` students reserve shared physical Ubuntu Desktop lab
machines. A successful checkout rotates and unlocks the one pre-existing `guest`
account on that machine and shows its temporary password exactly once.

This project does not provide remote desktop access and does not create
per-student Linux accounts.

## Local development

Requirements: Node.js 22+, npm, and SQLite support provided by Prisma.

1. Copy `.env.example` to `.env.local` and replace every blank or placeholder
   secret. The Google redirect URI is
   `http://localhost:3000/api/auth/callback/google` for local development.
2. Install and initialize the app:

   ```sh
   npm install
   npx prisma generate
   npx prisma migrate dev
   npx prisma db seed
   npm run dev
   ```

3. Open `http://localhost:3000`.

Use `npm test`, `npm run lint`, and `npm run build` before committing changes.

## Raspberry Pi deployment

Create `data/` and `secrets/` beside `docker-compose.yml`. Put the
`provisioner` private key at `secrets/provisioner_key`, mode `0600`, and set
production values in `.env.local`. Then run:

```sh
docker compose up --build -d
```

The container applies committed Prisma migrations before starting Next.js. The
SQLite database persists in `./data`; the SSH key is mounted read-only and is
never copied into the image.

Install `deploy/labgate-sweep.cron.example` in the Pi host's crontab after
replacing its placeholder with the same strong value used for `CRON_SECRET`.

## Lab machine enrollment

Each Ubuntu Desktop machine must already have Tailscale, curl, systemd, sudo,
and a pre-provisioned `provisioner` service account whose authorized key matches
the Pi's private key. Run `machine-setup/setup-machine.sh` as root with these
values supplied from a secure environment:

- `LABGATE_API_URL`: the Pi's Tailscale-only LabGate URL
- `LABGATE_REGISTRATION_SECRET`: the server's `MACHINE_REGISTRATION_SECRET`
- `TAILSCALE_AUTH_KEY`: needed only when the machine has not joined the tailnet
- `LABGATE_MACHINE_NAME`: optional display name
- `LABGATE_PAM_FILE`: optional display-manager PAM file override

The installer is idempotent. It creates the initial shared `guest` account via
`systemd-sysusers`, locks it, installs the constrained provisioning wrapper,
PAM hook, heartbeat, and cleanup timers, and enrolls one per-machine webhook
token. It is safe to rerun after an upgrade.

## Manual release validation

Before deploying to students, complete the unchecked Phase 8 steps in
`PROGRESS.md` on an Ubuntu Desktop machine or VM: real Google login, checkout,
physical login screen authentication, fresh tmpfs across logins, logout lock,
and independent recovery after killing the machine mid-session.
