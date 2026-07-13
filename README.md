# LabGate

LabGate lets students sign in with an `@ubu.ac.th` Google account, reserve a
shared physical Ubuntu Desktop lab machine, and receive a temporary password
for that machine.

A checkout rotates and unlocks the one pre-existing `guest` OS account. The
student types the password at the physical machine; LabGate is not a remote
desktop service. The password is returned once and is never stored by the web
application. Logout and the active-session cleanup timer lock the account, and
`/home/guest` is a temporary in-memory filesystem that is replaced for every
login.

> [!IMPORTANT]
> End-to-end validation with real Google credentials and a physical Ubuntu
> Desktop login screen is still outstanding. Read [PROGRESS.md](PROGRESS.md)
> before treating the system as production-ready.
>
> There is also a production-blocking expiration case to resolve: if a student
> checks out a machine but never logs in, the current local cleanup script sees
> no mounted guest home and exits. Continued heartbeats prevent the server
> sweep from handling that machine, so the rotated guest password can remain
> locally valid after its web credential expires. Keep machines in a controlled
> pilot until a no-login expiry path locks `guest` and its physical-machine test
> passes.

## How it fits together

```text
Student browser --HTTPS--> LabGate on Raspberry Pi --SSH over Tailscale--> Lab machine
                              ^                                  |
                              |---- webhooks over Tailscale -----|
```

- The Raspberry Pi runs Next.js, Better Auth, SQLite, and the provisioning
  service in Docker Compose.
- Google OAuth authenticates students. LabGate also checks the email domain on
  the server; Google's hosted-domain hint is not the only check.
- The Pi connects as the unprivileged `provisioner` service account and may
  `sudo` only `/usr/local/sbin/guest-account.sh`.
- Each machine has exactly one shared interactive account named `guest`.
- PAM hooks, heartbeat reporting, a local systemd cleanup timer, and a Pi-side
  cron sweep handle session state and recovery.

## Before you start

You need:

- A Raspberry Pi 5 running a 64-bit Linux distribution, with Docker Engine and
  the Docker Compose plugin installed.
- A Tailscale tailnet containing the Pi and every Ubuntu lab machine.
- A production HTTPS hostname for the student-facing web app, for example
  `https://labgate.example.ubu.ac.th`.
- Permission to create a Google OAuth web client for the `ubu.ac.th`
  organization.
- Ubuntu Desktop lab machines with a supported display manager (GDM, LightDM,
  or SDDM), `systemd`, PAM, OpenSSH Server, `curl`, `sudo`, and Tailscale.
- Administrator access to the Pi and every lab machine.

The commands below use one consistent worked example:

| Placeholder | Example | Meaning |
|---|---|---|
| `APP_URL` | `https://labgate.example.ubu.ac.th` | Student-facing HTTPS URL |
| `PI_TS_IP` | `100.88.10.5` | Pi's Tailscale IPv4 address |
| `LAB_TS_IP` | `100.93.42.17` | A lab machine's Tailscale IPv4 address |
| `ADMIN_USER` | `labadmin` | Existing local administrator on a lab machine |

Replace these example values with the addresses and usernames from your own
tailnet. Do not copy example IPs or secrets literally.

## Production setup on the Raspberry Pi

### 1. Install the prerequisites

Install Git, Docker Engine, the Docker Compose plugin, and Tailscale using their
official instructions. Join the Pi to the same tailnet as the lab machines,
then record its address:

```sh
tailscale ip -4
docker --version
docker compose version
```

Use Tailscale ACLs/grants to allow only:

- the Pi to reach TCP port 22 on the lab machines; and
- the lab machines to reach the LabGate HTTP port on the Pi.

Do not make lab-machine SSH or webhook traffic publicly reachable.

### 2. Download LabGate and create persistent directories

```sh
git clone <YOUR_REPOSITORY_URL> LabGate
cd LabGate
mkdir -p data secrets
chmod 700 data secrets
```

Run all remaining Pi commands from the repository root.

### 3. Generate the provisioning SSH key

Create a dedicated key with no passphrase. The container cannot answer a
passphrase prompt during checkout.

```sh
ssh-keygen -t ed25519 -f secrets/provisioner_key -N '' -C labgate-provisioner
chmod 600 secrets/provisioner_key
chmod 644 secrets/provisioner_key.pub
```

Use this key only for LabGate. Do not reuse a personal or administrator key.

### 4. Create the Google OAuth client

In Google Cloud Console:

1. Create or select the institution's Google Cloud project.
2. Configure the Google Auth Platform branding/consent screen. Select the
   institution-only audience when the Workspace configuration permits it.
3. Create a client of type **Web application**.
4. Add the production authorized redirect URI exactly as:

   ```text
   APP_URL/api/auth/callback/google
   ```

   For example:

   ```text
   https://labgate.example.ubu.ac.th/api/auth/callback/google
   ```

5. Save the generated client ID and client secret.

The scheme, hostname, port, path, case, and trailing slash must match. Google
normally requires HTTPS for non-localhost redirect URIs. See Google's
[web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server)
and [OpenID Connect guide](https://developers.google.com/identity/openid-connect/openid-connect).

### 5. Configure environment variables

Copy the template and restrict access:

```sh
cp .env.example .env.local
chmod 600 .env.local
```

Generate three independent secrets. Run the command separately for
`BETTER_AUTH_SECRET`, `MACHINE_REGISTRATION_SECRET`, and `CRON_SECRET`:

```sh
openssl rand -base64 32
```

Edit `.env.local`:

```dotenv
BETTER_AUTH_URL=https://labgate.example.ubu.ac.th
BETTER_AUTH_SECRET=<GENERATED_SECRET_1>
GOOGLE_CLIENT_ID=<GOOGLE_WEB_CLIENT_ID>
GOOGLE_CLIENT_SECRET=<GOOGLE_WEB_CLIENT_SECRET>
ALLOWED_EMAIL_DOMAIN=ubu.ac.th
DATABASE_URL=file:./data/labgate.db
PROVISIONER_SSH_KEY_PATH=/run/secrets/provisioner_key
CREDENTIAL_TTL_HOURS=3
MACHINE_REGISTRATION_SECRET=<GENERATED_SECRET_2>
CRON_SECRET=<GENERATED_SECRET_3>
```

Notes:

- `BETTER_AUTH_URL` must be the same origin students open and the origin used
  in the Google redirect URI.
- Keep `DATABASE_URL` and `PROVISIONER_SSH_KEY_PATH` at their shown container
  paths for the supplied Compose deployment.
- `CREDENTIAL_TTL_HOURS` defaults to three hours. Use the same duration when
  setting `LABGATE_MAX_TTL_SECONDS` on each lab machine.
- Never commit `.env.local`, `data/`, or `secrets/`.

### 6. Start the application

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 labgate
```

The container runs `prisma migrate deploy` on every start. Do not run the
development seed in production: it adds a fake lab machine.

At this point, verify the app locally on the Pi:

```sh
curl --fail --head http://127.0.0.1:3000/login
```

### 7. Publish the student-facing HTTPS URL

Put an HTTPS reverse proxy in front of `127.0.0.1:3000` and point `APP_URL` at
it. Configure the host firewall so port 3000 is not reachable from the public
internet; only the reverse proxy and the tailnet should reach it.

The reverse proxy must preserve the original `Host` and forwarded-protocol
headers. After it is configured, verify:

```sh
curl --fail --head https://labgate.example.ubu.ac.th/login
```

For a tailnet-only pilot, Tailscale Serve can provide an HTTPS reverse proxy:

```sh
sudo tailscale serve --bg 3000
tailscale serve status
```

Use the resulting `https://...ts.net` URL as `BETTER_AUTH_URL` and in Google
OAuth. This option is private to tailnet members, so it is usually unsuitable
for student devices that are not enrolled in Tailscale. See the
[Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve).

### 8. Install the Pi-side recovery sweep

The sweep releases expired credentials if a machine stops reporting activity.
Install the example in root's crontab and replace the placeholder with the exact
`CRON_SECRET` value from `.env.local`:

```sh
sudo crontab -e
```

Add:

```cron
* * * * * curl --fail --silent --show-error --max-time 20 --request POST --header "Authorization: Bearer REPLACE_WITH_CRON_SECRET" http://127.0.0.1:3000/api/cron/sweep >/dev/null
```

Test it without printing the secret to application logs:

```sh
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  http://127.0.0.1:3000/api/cron/sweep
```

If the variable is not already in your shell, read it into a temporary shell
variable without adding it to history:

```sh
read -rsp 'CRON_SECRET: ' CRON_SECRET
export CRON_SECRET
```

Unset it after the test:

```sh
unset CRON_SECRET
```

## Enroll each Ubuntu lab machine

Repeat this section for every physical lab machine. Do not create student OS
accounts. `setup-machine.sh` creates the single `guest` account only during
initial setup and then only rotates or locks its password.

### 1. Install and verify machine prerequisites

On the lab machine:

```sh
sudo apt update
sudo apt install --yes curl openssh-server sudo
sudo systemctl enable --now ssh
```

Install Tailscale using its official instructions, join the same tailnet as the
Pi, and verify both directions. This worked example consistently uses
`100.88.10.5` for the Pi and `100.93.42.17` for the Ubuntu lab machine.

```sh
tailscale ip -4
tailscale ping 100.88.10.5
```

On the Pi, verify the lab machine is reachable:

```sh
tailscale ping 100.93.42.17
```

The remaining examples assume the machine has an existing administrator named
`labadmin`. Replace that username with the real local administrator account.

### 2. Copy the setup files to the lab machine

The lab machine needs the complete `machine-setup/` directory and the
provisioning **public** key. Choose one of the following methods based on the
computer from which you are working.

Never copy `secrets/provisioner_key` (the private key) away from the Pi. Only
copy `secrets/provisioner_key.pub`.

#### Option A: Copy directly from the Raspberry Pi

Run these commands from the LabGate repository on the Pi:

```sh
cd /path/to/LabGate
scp secrets/provisioner_key.pub labadmin@100.93.42.17:/tmp/labgate-provisioner.pub
scp -r machine-setup labadmin@100.93.42.17:/tmp/labgate-machine-setup
```

Each `scp` command above is one line. If you split a shell command with `\`,
the backslash must be the final character on that line with no spaces after it;
otherwise `scp` may report `stat local " ": No such file or directory` even
after the intended file was copied.

If your prompt looks like `user@raspberrypi:~/LabGate$`, stop here: Option A is
the correct path. Do not run the `/tmp/labgate-provisioner.pub` relay commands
from Option B on the Pi. Also replace `labadmin` with the real administrator
username on the destination; for example, use `mashiro@...` if that is the
account that exists there.

#### Option B: Copy from another Linux or macOS computer

Install Git and the OpenSSH client on the operator computer. Clone the public
repository, fetch the public key from the Pi, and forward both items to the lab
machine. Replace `piadmin` and `/path/to/LabGate` with the actual Pi account and
repository path. Use this relay only when the current computer is not the Pi:

```sh
git clone https://github.com/tantaihaha4487/LabGate.git
cd LabGate
scp piadmin@100.88.10.5:/path/to/LabGate/secrets/provisioner_key.pub /tmp/labgate-provisioner.pub
scp /tmp/labgate-provisioner.pub labadmin@100.93.42.17:/tmp/labgate-provisioner.pub
scp -r machine-setup labadmin@100.93.42.17:/tmp/labgate-machine-setup
```

Delete the temporary public-key copy when finished:

```sh
rm -f /tmp/labgate-provisioner.pub
```

#### Option C: Copy from Windows PowerShell

Windows is supported as the operator computer used to copy files. Install Git
and the Windows OpenSSH Client first, then open PowerShell:

```powershell
git clone https://github.com/tantaihaha4487/LabGate.git
Set-Location LabGate
scp.exe piadmin@100.88.10.5:/path/to/LabGate/secrets/provisioner_key.pub .\labgate-provisioner.pub
scp.exe .\labgate-provisioner.pub labadmin@100.93.42.17:/tmp/labgate-provisioner.pub
scp.exe -r .\machine-setup labadmin@100.93.42.17:/tmp/labgate-machine-setup
Remove-Item .\labgate-provisioner.pub
```

The destination lab machine itself must be Ubuntu Desktop. A Windows machine
cannot be enrolled as a LabGate endpoint because the machine-side security
model requires PAM, `systemd`, tmpfs, `passwd`, and Linux sudoers. Windows may
only be used as the administrator/operator computer in this workflow.

Confirm that all files arrived, from any operator computer with SSH:

```sh
ssh labadmin@100.93.42.17 \
  'find /tmp/labgate-machine-setup -maxdepth 1 -type f -print'
```

Expected files include `setup-machine.sh`, `guest-account.sh`, the PAM session
hook, cleanup and heartbeat scripts, systemd units, and the sudoers file. Copy
the whole directory; `setup-machine.sh` reads those neighboring files during
installation.

### 3. Create the provisioning service identity

The installer intentionally requires an existing `provisioner` account. This
account is infrastructure, not a student or guest account.

Connect to the destination machine:

```sh
ssh labadmin@100.93.42.17
```

On the lab machine, create the service account and install the copied public
key:

```sh
sudo tee /etc/sysusers.d/labgate-provisioner.conf >/dev/null <<'EOF'
u provisioner - "LabGate SSH provisioner" /var/lib/labgate-provisioner /bin/bash
EOF
sudo systemd-sysusers /etc/sysusers.d/labgate-provisioner.conf
sudo install -d -o provisioner -g provisioner -m 0700 \
  /var/lib/labgate-provisioner/.ssh
sudo install -o provisioner -g provisioner -m 0600 \
  /tmp/labgate-provisioner.pub \
  /var/lib/labgate-provisioner/.ssh/authorized_keys
sudo rm -f /tmp/labgate-provisioner.pub
```

Confirm `/etc/ssh/sshd_config` allows public-key authentication, then reload
SSH if you changed it:

```sh
sudo sshd -t
sudo systemctl reload ssh
```

### 4. Run the machine installer

On the lab machine, become root. Read the registration secret without placing
it in shell history, configure the installer, and run it:

```sh
sudo -i
read -rsp 'Machine registration secret: ' LABGATE_REGISTRATION_SECRET
export LABGATE_REGISTRATION_SECRET
export LABGATE_API_URL='http://100.88.10.5:3000'
export LABGATE_MACHINE_NAME='Lab A - PC 01'
export LABGATE_MAX_TTL_SECONDS='10800'
/tmp/labgate-machine-setup/setup-machine.sh
unset LABGATE_REGISTRATION_SECRET
exit
```

In this worked example, `100.88.10.5` is always the Pi and
`100.93.42.17` is always the destination Ubuntu lab machine.

`LABGATE_API_URL` should use the Pi's Tailscale address or tailnet-only DNS
name—not the public student URL. If the machine has not joined Tailscale yet,
you may also supply `TAILSCALE_AUTH_KEY`; prefer a tagged, reusable or ephemeral
key with the narrowest practical permissions, and unset it immediately.

The installer automatically chooses one of these PAM files:

- `/etc/pam.d/gdm-password`
- `/etc/pam.d/lightdm`
- `/etc/pam.d/sddm`

For another display manager, set `LABGATE_PAM_FILE` to its session PAM file only
after reviewing that display manager's PAM flow.

The installer is idempotent. Rerunning it updates scripts, sudoers, PAM, and
systemd units without creating another guest account. It preserves the existing
per-machine webhook token.

### 5. Verify the machine installation

On the lab machine:

```sh
getent passwd guest provisioner
sudo passwd --status guest
sudo visudo -cf /etc/sudoers.d/labgate-guest-provision
sudo systemctl status guest-cleanup.timer guest-heartbeat.timer
sudo journalctl -u guest-heartbeat.service --since '10 minutes ago'
sudo test -s /etc/labgate/webhook-token
sudo test "$(stat -c %a /etc/labgate/webhook-token)" = 600
```

On the Pi, test the exact SSH path used by the app:

```sh
ssh -i secrets/provisioner_key \
  -o IdentitiesOnly=yes \
  provisioner@100.93.42.17 \
  'sudo /usr/local/sbin/guest-account.sh revoke'
```

The command should succeed without a password prompt. Do not test `issue` with
a real student present; it changes the current guest password.

## End-to-end acceptance test

Complete this test on a non-production machine before rollout:

1. Open the production app URL and sign in with a valid `@ubu.ac.th` account.
2. Confirm a non-`@ubu.ac.th` account cannot establish a session.
3. Confirm the enrolled machine appears as available.
4. Check out the machine and record the one-time password.
5. At the physical Ubuntu login screen, sign in as `guest` with that password.
6. Create a harmless file in `/home/guest`, then log out.
7. Confirm the guest account is locked and the machine becomes available again.
8. Check out and log in again; confirm the file from the prior session is gone
   and `/home/guest` is a fresh tmpfs mount.
9. Test expiration during an open guest session by using a short TTL on a test
   machine. Confirm the local cleanup timer locks the account even if webhooks
   are unavailable.
10. Test expiration without ever logging in. This test currently exposes the
    production-blocking issue described at the top of this README; do not
    deploy until the password is locked automatically in this case.
11. Simulate a powered-off or disconnected machine and confirm the Pi cron
    sweep eventually revokes the expired credential and releases the machine.
12. Review the Pi and lab-machine logs for errors.

Do not check off Phase 8 in [PROGRESS.md](PROGRESS.md) until the real physical
login, fresh-home, logout, and failure-recovery tests pass.

## Local development

Local development requires Node.js 22+, npm, and Google OAuth credentials with
this additional authorized redirect URI:

```text
http://localhost:3000/api/auth/callback/google
```

Set up the project:

```sh
npm install
mkdir -p data secrets
cp .env.example .env.local
```

For local execution outside Docker, change these values in `.env.local`:

```dotenv
BETTER_AUTH_URL=http://localhost:3000
DATABASE_URL=file:./data/labgate.db
PROVISIONER_SSH_KEY_PATH=./secrets/provisioner_key
```

Fill every blank secret and Google credential, then initialize and run:

```sh
npx prisma generate
npx prisma migrate dev
npx prisma db seed
npm run dev
```

Open <http://localhost:3000>. The seed creates a fake machine at `100.64.0.10`;
listing works, but checkout requires a reachable test machine with the
provisioning key installed.

Before committing changes:

```sh
npm test
npm run lint
npm run build
```

## Operations

### Back up SQLite

The database contains user, session, machine-token, credential metadata, and
audit records, but never guest passwords. Stop writes before copying it:

```sh
docker compose stop labgate
cp data/labgate.db "data/labgate.db.backup-$(date +%Y%m%d-%H%M%S)"
docker compose start labgate
```

Store backups encrypted with access limited to administrators. Test restoration
on a separate host periodically.

### Update LabGate

Back up the database first, review release and migration changes, then:

```sh
git pull --ff-only
docker compose up --build -d
docker compose logs --tail=100 labgate
```

Copy the updated `machine-setup/` directory to each lab machine and rerun
`setup-machine.sh` when machine-side files change.

### Rotate secrets

- Rotate the Google client secret in Google Cloud, update `.env.local`, and
  restart the container.
- Rotating `BETTER_AUTH_SECRET` invalidates existing sessions.
- After rotating `CRON_SECRET`, update root's crontab immediately.
- After rotating `MACHINE_REGISTRATION_SECRET`, use the new value only for new
  or deliberately re-enrolled machines.
- To rotate the provisioning SSH key, install the new public key on every
  machine before replacing `secrets/provisioner_key` and restarting LabGate.

### Logs and health checks

```sh
docker compose ps
docker compose logs --since=30m labgate
sudo journalctl -u guest-heartbeat.service -u guest-cleanup.service --since today
tailscale status
```

Treat logs and the database as sensitive: audit entries include student email
addresses.

## Troubleshooting

### Google reports `redirect_uri_mismatch`

Check that `BETTER_AUTH_URL` plus `/api/auth/callback/google` exactly matches an
authorized redirect URI in Google Cloud. Restart the container after changing
`.env.local`.

### A valid student receives a domain error

Confirm `ALLOWED_EMAIL_DOMAIN=ubu.ac.th` without whitespace or a misspelling.
LabGate intentionally checks the email suffix on the server in addition to
Google's hosted-domain setting.

### Checkout fails or the machine remains unavailable

Verify, in order:

1. `tailscale ping 100.93.42.17` works from the Pi.
2. TCP port 22 is allowed from the Pi to the machine.
3. The private key is mounted at `/run/secrets/provisioner_key` in the container.
4. The `provisioner` account owns its `authorized_keys` file.
5. The SSH test in the enrollment section succeeds without interaction.
6. `/etc/sudoers.d/labgate-guest-provision` passes `visudo -cf`.

Then inspect `docker compose logs labgate` and the machine's SSH journal.

### The machine does not appear after setup

Check the heartbeat timer and confirm the machine can reach
`http://100.88.10.5:3000`. If the Pi database was replaced but the machine still
has `/etc/labgate/webhook-token`, the token no longer matches a database row.
Deliberate re-enrollment requires removing that file, rerunning the installer
with `LABGATE_REGISTRATION_SECRET`, and protecting the newly issued token.

### Setup cannot find a PAM file

Identify the display manager's session PAM file and rerun with
`LABGATE_PAM_FILE=/etc/pam.d/<file>`. Do not guess: an incorrect PAM file can
leave cleanup hooks inactive or interfere with login.

### Guest data persists after logout

Remove the machine from student use immediately. Check that the PAM hook exists
in the selected display-manager file, inspect `guest-cleanup.service`, and
verify `/home/guest` is mounted as tmpfs during a session. This is a security
failure, not a cosmetic issue.

## Security and deployment recommendations

- Keep the app, Pi, and lab machines patched; pin and review dependency updates.
- Restrict the student web app to HTTPS and apply rate limiting at the reverse
  proxy, especially to auth and API routes.
- Use Tailscale ACLs/grants and host firewalls for least-privilege connectivity.
- Never expose SSH on lab machines to the public internet.
- Keep `.env.local`, the provisioning key, webhook tokens, SQLite backups, and
  audit logs out of source control and administrator chat systems.
- Use a dedicated tagged Tailscale identity for the Pi and lab machines rather
  than personal device identities.
- Monitor disk space, container restarts, failed provisioning, stale
  heartbeats, and timer failures.
- Keep the local systemd cleanup timer and Pi cron sweep enabled; they cover
  different failure modes.
- Perform the full acceptance test after changes to auth, checkout,
  provisioning, PAM, sudoers, timers, or networking.
- Document a lab shutdown procedure and an incident process for a guest session
  that fails to lock or clear.

## Project references

- [AGENTS.md](AGENTS.md) — architecture, conventions, and security invariants
- [BUILD_PROMPT.md](BUILD_PROMPT.md) — phased implementation and acceptance plan
- [PROGRESS.md](PROGRESS.md) — current implementation and validation status
- [`.env.example`](.env.example) — required application configuration
- [`machine-setup/`](machine-setup/) — lab-machine installer and security hooks
- [`deploy/labgate-sweep.cron.example`](deploy/labgate-sweep.cron.example) — Pi
  recovery sweep template
