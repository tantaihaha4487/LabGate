# LabGate operations runbook

This runbook is for the Raspberry Pi application host and physical Ubuntu
Desktop lab machines. Commands use placeholders and never contain a real secret.
Run destructive or session-ending procedures only in a declared maintenance
window.

## Operating rules

1. The tracked source of truth is the development workstation checkout.
   Validate, commit, and push there; then fast-forward pull `~/LabGate` on the Pi.
   Never patch a tracked project file directly on the Pi. Runtime-only `.env.local`
   and root-controlled configuration may be changed on the host.
2. Do not release a machine because a deadline passed or a heartbeat stopped.
   Release requires confirmed version-3 state for the exact credential generation,
   a locked guest account, and no active physical session.
3. `CREDENTIAL_TTL_HOURS` is only the pending physical-login deadline.
   There is no maximum duration for an active session unless you specify one.
4. Never display, log, paste into a ticket, or place in command arguments a bearer
   token. Use permission-restricted configuration files.
5. A generated guest password is intentionally sent once during provisioning as
   exactly one newline-terminated SSH stdin line. It must never appear in
   `SSH_ORIGINAL_COMMAND`, sudo/process arguments, the database, machine state,
   documentation, or logs.
6. Keep an administrator SSH session open while changing PAM or SSH policy, and
   have physical-console recovery available.

## Initial Pi, OAuth, and network setup

### Pi prerequisites and clone

Install a supported 64-bit Raspberry Pi operating system, Git, Docker Engine,
the Docker Compose plugin, Tailscale, `sqlite3`, and a time-synchronization
service. Join the Pi to the same tailnet as every lab endpoint and verify:

```sh
docker --version
docker compose version
tailscale status
tailscale ip -4
timedatectl status
```

For a first deployment, clone the reviewed repository; subsequent changes must
follow commit-push-Pi-pull:

```sh
REPOSITORY_URL='https://github.com/tantaihaha4487/LabGate.git'
git clone "$REPOSITORY_URL" ~/LabGate
cd ~/LabGate
install -d -m 700 data secrets backups
```

Tailscale and host firewall policy should permit only:

- the Pi to reach endpoint TCP port 22 for provisioning;
- endpoints to reach the Pi application port for heartbeat/webhooks; and
- administrator management paths explicitly required by the institution.

Do not expose endpoint SSH publicly. Compose currently publishes Pi port 3000 on
host interfaces, so the Pi firewall must restrict it to the reverse proxy,
tailnet, and intended management sources.

### Dedicated provisioning key

Generate a dedicated no-passphrase Ed25519 key on the Pi. The container cannot
answer a passphrase prompt during checkout:

```sh
cd ~/LabGate
ssh-keygen -t ed25519 \
  -f secrets/provisioner_key \
  -N '' \
  -C labgate-provisioner
chmod 600 secrets/provisioner_key
chmod 644 secrets/provisioner_key.pub
```

The private key remains on the Pi and is mounted read-only into the container.
Only the public key is installed on endpoints. Never reuse an administrator's
personal key.

### Google OAuth application

Create an institution-controlled Google OAuth **Web application**. Configure the
organization audience when available and add the exact redirect URI:

```text
https://LABGATE_PUBLIC_ORIGIN/api/auth/callback/google
```

Scheme, host, optional port, path, case, and trailing slash must match
`BETTER_AUTH_URL`. Add the localhost redirect only to a separate development
client or an explicitly approved development configuration.

Google's hosted-domain setting is a user-experience hint, not the authorization
boundary. Verify the server-side email suffix test independently before rollout.

### HTTPS publication and first start

Place an institution-approved HTTPS reverse proxy in front of the Pi application.
Preserve the original host and forwarded protocol headers. The public student
origin and Google redirect must use HTTPS; machine webhooks should use the Pi's
tailnet address or tailnet DNS name rather than the public route.

After creating `.env.local` and the provisioning key:

```sh
cd ~/LabGate
docker compose up --build -d
docker compose ps
docker compose logs --tail=200 labgate
curl --fail --head http://127.0.0.1:3000/login
```

The first start runs configuration/database preflight and all tracked Prisma
migrations. Do not run the development seed in production. Complete the root-only
cron configuration and one non-production machine enrollment before allowing a
student account to see an available endpoint.

## Configuration reference

### Raspberry Pi application

The production clone is `~/LabGate` on:

```text
labgate-1@raspberrypi.tailfdedcf.ts.net
```

Create `.env.local` from `.env.example`, restrict it to the deployment account,
and keep it untracked:

```sh
cd ~/LabGate
cp .env.example .env.local
chmod 600 .env.local
```

| Variable | Required production rule |
|---|---|
| `BETTER_AUTH_URL` | Exact HTTPS origin used by students and the Google redirect URI |
| `BETTER_AUTH_SECRET` | Independent high-entropy value |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Institution Google OAuth web client |
| `ALLOWED_EMAIL_DOMAIN` | `ubu.ac.th`, unless the institution explicitly changes it |
| `DATABASE_URL` | `file:./data/labgate.db` for supplied Compose deployment |
| `PROVISIONER_SSH_KEY_PATH` | Absolute readable non-empty regular mode-`0600` file; `/run/secrets/provisioner_key` in Compose; symlinks rejected |
| `CREDENTIAL_TTL_HOURS` | Pending-login window; one minute through 24 hours |
| `GUEST_PASSWORD_LENGTH` | Exact whole-number password length; 8 through 128 |
| `MACHINE_REGISTRATION_SECRET` | First-registration bearer value |
| `CRON_SECRET` | Pi sweep bearer value |

Generate each secret independently. Do not reuse the provisioning key or a
per-machine webhook token as an application secret.

The production entrypoint validates configuration before opening or migrating
the database:

- `BETTER_AUTH_URL` must be absolute HTTP(S), with a hostname and no embedded
  credentials or fragment;
- `BETTER_AUTH_SECRET` must be 32–512 non-whitespace characters;
- both Google values must be 8–512 non-whitespace characters;
- `ALLOWED_EMAIL_DOMAIN` must be a normalized valid DNS domain;
- registration and cron bearers must be 20–256-character RFC 6750 `b64token`
  values. The accepted set includes alphanumerics, `-`, `.`, `_`, `~`, `+`, `/`,
  and normal terminal `=` padding; whitespace or quoting is rejected;
- `DATABASE_URL` must be an explicit non-empty SQLite `file:` URL;
- TTL and password length must be within their exact ranges; and
- `PROVISIONER_SSH_KEY_PATH` must be an absolute, readable, non-empty regular
  mode-`0600` file inside the container. A directory, relative path, empty file,
  unreadable/loosely-permissioned file, or symlink fails startup.

Set every template variable explicitly in production even where an application
default exists. A failure stops before `prisma migrate deploy`; correct the
configuration instead of bypassing preflight.

Existing URL-safe registration and cron values are a subset of this accepted
syntax. The compatibility expansion to standard Base64 `+`, `/`, and trailing
`=` does not require Pi secret rotation. Rotate only for the normal compromise or
scheduled-rotation reasons, and coordinate the dependent root-only config.

Compose persists `./data` at `/app/data` and mounts
`./secrets/provisioner_key` read-only at `/run/secrets/provisioner_key`.
Protect both host directories:

```sh
install -d -m 700 data secrets
chmod 600 .env.local secrets/provisioner_key
```

### Exact password-length synchronization

The app generates exactly `GUEST_PASSWORD_LENGTH` characters. Every enrolled
machine independently reads the exact required length from the root-only file:

```text
/etc/labgate/password-length
```

The installer writes that file from `LABGATE_PASSWORD_LENGTH`. On an already
installed machine, omitting `LABGATE_PASSWORD_LENGTH` preserves the valid existing
value; on first install it defaults to `8`. For an auditable rollout, set it
explicitly and verify it equals the Pi value:

```sh
# Pi: prints only the non-secret configured length.
awk -F= '$1 == "GUEST_PASSWORD_LENGTH" { print $2 }' .env.local

# Lab machine:
sudo cat /etc/labgate/password-length
sudo stat -c '%U:%G %a %n' /etc/labgate/password-length
```

Expected ownership/mode is `root:root 600`. A mismatch makes provisioning fail;
it must never be worked around by weakening machine validation.

The endpoint independently requires every issue deadline to be in its future and
no more than 86,400 seconds plus a fixed 60-second clock-skew allowance ahead of
its local clock. Setup requires NTP synchronization. The extra minute is only a
transport/clock tolerance and does not expand the application-configurable
24-hour maximum. None of these deadlines limit a session that already became
active.

To change the length, stop new checkout traffic, wait for or intentionally close
all active sessions, confirm no pending credential, update every machine, update
the Pi setting, and restart the app. Do not run mixed lengths during checkout.

### Change Pi runtime configuration

Runtime configuration may be changed directly on the Pi because `.env.local` is
not a tracked project file. Treat it as a secret:

```sh
cd ~/LabGate
cp --preserve=mode .env.local ".env.local.backup-$(date +%Y%m%d-%H%M%S)"
chmod 600 .env.local.backup-*
${EDITOR:-vi} .env.local
chmod 600 .env.local
docker compose up -d --force-recreate labgate
docker compose ps
docker compose logs --tail=100 labgate
```

Do not run a command that renders the full Compose environment into terminal or
CI logs. The startup preflight rejects invalid TTL/password-length values before
migration. After `BETTER_AUTH_URL` or Google-client changes, verify the exact OAuth
redirect. Rotating `BETTER_AUTH_SECRET` ends existing web sessions. After rotating
`CRON_SECRET`, edit `/etc/labgate/cron-curl.conf` with `sudoedit` in the same
maintenance action. Delete the restricted backup after the retention window.

### Machine configuration and persistent data

`setup-machine.sh` accepts:

| Input | Meaning |
|---|---|
| `LABGATE_API_URL` | Required origin-only Pi URL over Tailscale: HTTP(S), canonical lowercase hostname or IPv4, optional port 1–65535; no userinfo/path/query/fragment |
| `LABGATE_MACHINE_NAME` | Required stable display name, or host short name by default |
| `LABGATE_PASSWORD_LENGTH` | Optional on update, but should explicitly match the app |
| `LABGATE_REGISTRATION_SECRET` | Required only when no valid machine token exists; 20–256-character RFC 6750 `b64token` |
| `LABGATE_PAM_FILE` | Optional reviewed selection of a supported GDM/LightDM/SDDM primary password stack |
| `LABGATE_MIGRATE_LEGACY_OUTBOX` | Unset normally; exact value `1` authorizes the drained legacy outbox procedure below |
| `TAILSCALE_AUTH_KEY` | Optional first-join value; unset immediately after use |

Installed root-controlled configuration is under `/etc/labgate/`:

- `api-url` — Pi webhook base URL;
- `password-length` — exact accepted guest-password length;
- `pam-file` — selected display-manager PAM file;
- `auth-failure-backends` — canonical list of selected-stack PAM counters reset
  before every issue (`none`, `faillock`, `pam_tally2`, and/or `pam_tally`);
- `ssh-host-key-sha256` — non-secret canonical Ed25519 host-key pin paired with
  this endpoint registration;
- `webhook-token` — per-machine bearer value; and
- `webhook-curl.conf` — curl headers containing the bearer value.

Never print the bearer-bearing last two files. The PAM backend list and SSH pin
are non-secret, but keep every file in this directory `root:root 0600` so an
unprivileged account cannot change machine identity or lifecycle behavior.

Valid machine API origins include `http://100.64.0.5:3000` and
`https://raspberrypi.tailnet-name.ts.net`. A trailing `/` is a path and is
rejected, as are credentials, query/fragment text, IPv6, uppercase/trailing-dot or
otherwise non-canonical DNS, leading-zero IPv4 octets, port 0, leading-zero ports,
and ports above 65535. The installed webhook sender validates the persisted value
again before every request.

## Commit, push, Pi pull, and deploy

### 1. Validate and publish from the development machine

From the development checkout:

```sh
git status --short
npm test
npm run lint
npm run build
git diff --check
git add -- path/to/reviewed-file
git diff --cached
git commit -m 'describe the validated change'
git push
```

Do not include `.env*`, database files, backups, keys, or runtime tokens in the
commit. Confirm the pushed commit ID:

```sh
git rev-parse HEAD
```

### 2. Connect to and inspect the Pi

```sh
ssh 'labgate-1@raspberrypi.tailfdedcf.ts.net'
cd ~/LabGate
git status --short
docker compose ps
```

Stop if tracked files are modified on the Pi. Preserve and investigate them;
do not overwrite them with a reset. Ignored runtime files are expected.

Fetch and review what will change before stopping service:

```sh
branch=$(git branch --show-current)
git fetch origin "$branch"
git log --oneline --decorate HEAD.."origin/$branch"
git diff --stat HEAD.."origin/$branch"
git diff HEAD.."origin/$branch" -- prisma/migrations deploy machine-setup
```

### 3. Back up SQLite

Install the `sqlite3` CLI on the Pi if it is not already available. Create a
restricted backup directory, stop writes, and make a SQLite-native backup:

```sh
install -d -m 700 backups
docker compose stop labgate
timestamp=$(date +%Y%m%d-%H%M%S)
backup="backups/labgate-${timestamp}.db"
sqlite3 data/labgate.db ".backup '$backup'"
chmod 600 "$backup"
sqlite3 "$backup" 'PRAGMA integrity_check;'
sqlite3 "$backup" 'PRAGMA foreign_key_check;'
```

`integrity_check` must print `ok`; `foreign_key_check` must print nothing. If
either fails, keep the app stopped and repair or restore before migrating.
Copy a tested backup to encrypted administrator storage under the retention
policy. The database includes student identities, sessions, machine bearer
tokens, and audit data even though it never includes guest passwords.

### 4. Run the identity and duplicate-active-row preflight

The lifecycle migrations make machine name, Tailscale address, and every non-null
SSH host-key pin unique and
creates partial unique indexes permitting only one unrevoked row per machine and
per case-normalized student email. Query before pulling and migrating:

```sh
sqlite3 -header -column data/labgate.db <<'SQL'
SELECT id, name, tailscale_ip, status
FROM machines
ORDER BY name;

SELECT name, COUNT(*) AS machine_rows
FROM machines
GROUP BY name
HAVING COUNT(*) > 1;

SELECT tailscale_ip, COUNT(*) AS machine_rows
FROM machines
GROUP BY tailscale_ip
HAVING COUNT(*) > 1;

SELECT machine_id, COUNT(*) AS unrevoked_count
FROM guest_credentials
WHERE revoked_at IS NULL
GROUP BY machine_id
HAVING COUNT(*) > 1;

SELECT LOWER(student_email) AS normalized_email,
       COUNT(*) AS unrevoked_count
FROM guest_credentials
WHERE revoked_at IS NULL
GROUP BY LOWER(student_email)
HAVING COUNT(*) > 1;

SELECT id, name, tailscale_ip
FROM machines AS machine
WHERE machine.status = 'available'
  AND EXISTS (
    SELECT 1 FROM guest_credentials AS credential
    WHERE credential.machine_id = machine.id
      AND credential.revoked_at IS NULL
  );

SELECT id, name, tailscale_ip
FROM machines AS machine
WHERE machine.status = 'occupied'
  AND NOT EXISTS (
    SELECT 1 FROM guest_credentials AS credential
    WHERE credential.machine_id = machine.id
      AND credential.revoked_at IS NULL
  );
SQL
```

On a database where the lifecycle migration has already added the safety-hold
column, inventory every hold and fail any impossible available/held row:

```sh
HAS_SAFETY_HOLD_COLUMN=$(sqlite3 data/labgate.db \
  "SELECT COUNT(*) FROM pragma_table_info('machines') WHERE name='safety_hold_credential_id';")
if test "$HAS_SAFETY_HOLD_COLUMN" = 1; then
  sqlite3 -header -column data/labgate.db <<'SQL'
SELECT id, name, tailscale_ip, status, safety_hold_credential_id
FROM machines
WHERE safety_hold_credential_id IS NOT NULL
ORDER BY name;

SELECT id, name, tailscale_ip, safety_hold_credential_id
FROM machines
WHERE status = 'available'
  AND safety_hold_credential_id IS NOT NULL;
SQL
fi
unset HAS_SAFETY_HOLD_COLUMN
```

After the SSH-pin migration exists, inventory legacy null pins and prove all
non-null values are unique. Every null row remains unassignable until the explicit
drained null-CAS rekey; do not populate it with ad hoc SQL:

```sh
HAS_SSH_PIN_COLUMN=$(sqlite3 data/labgate.db \
  "SELECT COUNT(*) FROM pragma_table_info('machines') WHERE name='ssh_host_key_sha256';")
if test "$HAS_SSH_PIN_COLUMN" = 1; then
  sqlite3 -header -column data/labgate.db <<'SQL'
SELECT id, name, tailscale_ip, status
FROM machines
WHERE ssh_host_key_sha256 IS NULL
ORDER BY name;

SELECT ssh_host_key_sha256, COUNT(*) AS machine_rows
FROM machines
WHERE ssh_host_key_sha256 IS NOT NULL
GROUP BY ssh_host_key_sha256
HAVING COUNT(*) > 1;
SQL
fi
unset HAS_SSH_PIN_COLUMN
```

Every listed address must be canonical Tailscale CGNAT IPv4 text: no leading
zeroes and inside `100.64.0.0/10`. The four duplicate queries and
`available`-with-current query must return no rows. The available-with-hold query
must also return no rows; any other hold is a quarantine inventory requiring the
exact-generation procedure below. The final
`occupied`-without-current query is quarantine inventory: such rows remain
occupied and produce a startup warning, but do not fail migration. They require
manual physical reconciliation and must never be silently changed to available.

The container entrypoint also runs `deploy/preflight-migration.mjs` before
`prisma migrate deploy`, so startup fails closed if configuration, canonical
machine identity, unique credential state, or available/current consistency is
invalid. It also fails if an `available` row has a non-null safety hold.

For a duplicate name/address/pin, stop. Identify the one physical endpoint, choose a
canonical database row, preserve related credential/audit history, reconcile all
credentials to locally confirmed safe state, and keep the endpoint quarantined.
Registration `POST` is immutable and cannot repair or merge duplicate rows. The
drained rekey `PATCH` below changes exactly one known row only after uniqueness
preflight passes; it is not a duplicate-merge tool. Reconcile duplicate history
through reviewed maintenance first. Do not merely rename a duplicate, discard
history, or delete a token to make the index pass.

If conflicts exist:

1. Keep the app stopped and retain the backup.
2. List every conflicting credential ID, machine, email, deadline, current
   version, and `safety_hold_credential_id` without exposing any bearer value.
3. Put each affected physical machine into maintenance. If any session may be
   active, allow orderly logout or use the boot-lock recovery procedure below.
4. Prove the machine is locally locked, has no guest session/process, and has no
   guest tmpfs mounted.
5. Reconcile every obsolete row to revoked/version 3 in one reviewed transaction,
   then repeat all preflight queries. Never keep a row merely because its
   timestamp is newest; physical state is authoritative.
6. Record the incident and exact affected IDs in the restricted operator log.

Do not solve this by deleting the unique migration or releasing an unverified
machine.

### 5. Mandatory old-protocol upgrade and reconciliation

Run this gate before the first deployment of generation IDs, state versions,
persistent outbox, boot lock, or the uniqueness migration. It is required even
when the database query currently returns zero unrevoked rows; the zero-row result
must be recorded, and every enrolled endpoint must still be upgraded and proven
dormant-safe.

#### A. Stop checkout and inventory every unrevoked row

Keep the Pi app stopped after backup. Query every row, not only duplicates:

```sh
sqlite3 -header -column data/labgate.db <<'SQL'
SELECT gc.id AS credential_id,
       gc.machine_id,
       m.name,
       m.tailscale_ip,
       gc.student_email,
       gc.expires_at,
       gc.revoked_at
FROM guest_credentials AS gc
JOIN machines AS m ON m.id = gc.machine_id
WHERE gc.revoked_at IS NULL
ORDER BY m.name, gc.created_at;
SQL
```

Create a restricted reconciliation worksheet containing these IDs and one of:
`no physical session`, `orderly logout completed`, or `fail-safe secured`. Never
assume an expired row has no physical session.

#### B. Drain and locally secure each affected old-protocol endpoint

For each row, use the physical console or an independent administrator session:

1. Prevent new student use.
2. If a guest desktop is active, request orderly logout. If it cannot close,
   declare disruption and terminate it through the administrator recovery path.
3. Lock the shared guest account, terminate all guest real/effective-UID
   processes, and perform a normal verified unmount of `/home/guest` if mounted.
4. Verify no logind guest session, guest process, or tmpfs remains and that the
   account reports locked.
5. Mark the corresponding database credential ID `verified local lock` in the
   worksheet. Do not put an unverified ID in the database transaction below.

The explicit old-protocol containment sequence is:

```sh
sudo passwd -l guest
sudo loginctl terminate-user guest || true
GUEST_UID=$(id -u guest)
sudo pkill -TERM -u "$GUEST_UID" || true
sudo pkill -TERM -U "$GUEST_UID" || true
sleep 2
sudo pkill -KILL -u "$GUEST_UID" || true
sudo pkill -KILL -U "$GUEST_UID" || true
if mountpoint --quiet /home/guest; then
  sudo umount /home/guest
fi
sudo passwd --status guest
sudo loginctl list-sessions --no-legend
sudo pgrep -a -u "$GUEST_UID"
sudo pgrep -a -U "$GUEST_UID"
sudo findmnt --target /home/guest
```

The final four inspection commands must show locked status and no guest
session/process/mount. A non-zero `umount` or remaining process is a failed gate;
do not use a lazy unmount. If an old endpoint cannot be reached, keep its rows
unrevoked and the machine non-available; repair physical access before migrating.

#### C. Transactionally close only physically verified rows

Check whether the lifecycle columns already exist:

```sh
sqlite3 data/labgate.db <<'SQL'
SELECT name
FROM pragma_table_info('guest_credentials')
WHERE name = 'machine_state_version';
SELECT name
FROM pragma_table_info('machines')
WHERE name = 'safety_hold_credential_id';
SQL
```

Prepare a root-restricted SQL file. Insert only worksheet IDs whose local lock was
proved. When both lifecycle columns exist, use this transaction:

```sql
BEGIN IMMEDIATE;
CREATE TEMP TABLE verified_revocations (
  id TEXT PRIMARY KEY
);
INSERT INTO verified_revocations(id) VALUES
  ('REPLACE_WITH_VERIFIED_CREDENTIAL_ID');

UPDATE guest_credentials
SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
    machine_state_version = 3
WHERE revoked_at IS NULL
  AND id IN (SELECT id FROM verified_revocations);
SELECT changes() AS revoked_rows;

UPDATE machines
SET status = CASE
  WHEN safety_hold_credential_id IS NOT NULL THEN 'occupied'
  WHEN EXISTS (
    SELECT 1 FROM guest_credentials AS active
    WHERE active.machine_id = machines.id
      AND active.revoked_at IS NULL
  ) THEN 'occupied'
  ELSE 'available'
END
WHERE id IN (
  SELECT credential.machine_id
  FROM guest_credentials AS credential
  JOIN verified_revocations AS verified ON verified.id = credential.id
);
COMMIT;
```

Before committing, compare the intended worksheet count with SQLite `changes()`
for the credential update. Afterward, query every inserted ID and rerun the full
identity/lifecycle preflight set.

On a genuinely pre-lifecycle schema neither column exists. Do not add either
manually, because that would make the tracked Prisma migration fail. Use the same
reviewed transaction without the `machine_state_version = 3` assignment and with
the original status expression that cannot reference the absent hold column. The
tracked migration adds the nullable machine hold and deterministically sets
version 3 for every already-revoked credential. If a hold column already exists,
the transaction above preserves it and keeps that machine occupied; never clear it
in reconciliation SQL. Immediately after migration, verify every worksheet ID has
`machine_state_version = 3`, every newly added hold is null, and no available/held
row exists before reopening checkout.

#### D. Install the new machine protocol while the app remains stopped

On every already-pinned enrolled endpoint, not just machines that had a row:

1. Copy the complete committed `machine-setup/` directory.
2. Run the installer in the drained window with the exact app password length.
3. Verify boot lock, cleanup, heartbeat, and webhook-flush units are enabled.
4. Prove the guest account is locked, no guest session/process exists,
   `/home/guest` is not mounted, and persistent state is absent or
   revoked/version 3.
5. Verify the heartbeat snapshot implied by local state is either null/locked/
   inactive or the exact revoked generation/version 3. It must not be pending or
   active before startup.

A pre-pin legacy endpoint normally has `/etc/labgate/webhook-token` but no
`/etc/labgate/ssh-host-key-sha256`. The new installer must refuse that state
before privileged policy changes. Do not delete/rename the token and do not write
a marker by hand. Keep the endpoint manually locked and drained, stage the
complete new installer, record its canonical live Ed25519 fingerprint, and defer
its installer run until the database migration is live behind blocked student
ingress. Section E then uses the authenticated drained PATCH with exact
`expectedSshHostKeySha256: null`, installs the returned token plus computed pin,
and runs setup.

If an exact-identity token file is missing, treat recovery as manual maintenance.
The app may be started temporarily only after all old rows are safely reconciled;
an idempotent registration request must use the already-stored exact canonical
name/address/host-pin triple and can only return its existing token. It cannot change
identity or rotate a potentially exposed token. A required identity/token/pin change
must instead meet the drained `PATCH` preconditions and follow the rekey procedure
below; keep checkout closed throughout. Stop again for the final migration gate
and never reopen student checkout during this recovery.

#### E. Migrate, reconcile heartbeat, then reopen

Only after A–D pass may the Pi pull/build/start sequence continue, with student
ingress still blocked. After migration/startup on the operator-only path:

1. Verify the migration and that every pre-lifecycle revoked worksheet row is
   version 3.
2. Inventory every `ssh_host_key_sha256 IS NULL` machine. For each one, re-prove
   the drained PATCH gates, complete the explicit legacy-null rekey procedure,
   install pin then token root-only, and run the full staged installer. Do not
   batch or use SQL to claim pins.
3. Trigger one heartbeat per endpoint and confirm Pi state is null-or-revoked,
   locked, and inactive for the exact machine identity.
4. Verify no outbox/recovery backlog is unexplained.
5. Repeat the complete identity/lifecycle preflight set and review quarantine
   warnings. Confirm every `safety_hold_credential_id` is null; reconcile any hold
   against its exact physical generation before continuing.
6. Reopen checkout only after every enrolled endpoint has passed.

### 6. Pull, build, preflight, and migrate

Pull only the pushed commit path:

```sh
git pull --ff-only
git rev-parse HEAD
docker compose build labgate
docker compose run --rm --no-deps --entrypoint node \
  labgate ./deploy/preflight-migration.mjs
docker compose up -d
docker compose ps
docker compose logs --tail=200 labgate
```

The normal entrypoint reruns preflight, runs `npx prisma migrate deploy`, and
starts Next.js. Verify the expected migration and health before reopening use:

```sh
docker compose exec -T labgate npx prisma migrate status
curl --fail --head http://127.0.0.1:3000/login
```

If any command fails, keep the service closed to students and use the rollback
section. If deployment was aborted before pull, restart the old service with
`docker compose start labgate`.

## Pi cron sweep without a bearer in argv

The sweep is defense in depth for expired pending credentials. It never releases
an active session and never releases an unreachable machine without confirmed
lock state.

Create a root-only curl configuration. Use `sudoedit` so the bearer is not placed
in shell history or a process argument:

```sh
sudo install -d -o root -g root -m 0700 /etc/labgate
sudo install -o root -g root -m 0600 /dev/null /etc/labgate/cron-curl.conf
sudoedit /etc/labgate/cron-curl.conf
```

Enter one line, substituting the actual `CRON_SECRET` only inside the editor:

```text
header = "Authorization: Bearer REPLACE_IN_EDITOR"
```

Verify metadata without printing content:

```sh
sudo test -s /etc/labgate/cron-curl.conf
sudo test "$(sudo stat -c %U:%G /etc/labgate/cron-curl.conf)" = root:root
sudo test "$(sudo stat -c %a /etc/labgate/cron-curl.conf)" = 600
```

Install this root crontab line:

```cron
* * * * * /usr/bin/curl --config /etc/labgate/cron-curl.conf --fail --silent --show-error --max-time 20 --request POST http://127.0.0.1:3000/api/cron/sweep >/dev/null
```

Test the same command interactively, then inspect application logs. The process
list and crontab should show only the configuration-file path, never the bearer.

## Machine installation and update

### Prerequisites and variables

Use a non-production endpoint first. Define non-secret operator values locally:

```sh
PI_TS_HOST='raspberrypi.tailfdedcf.ts.net'
LAB_TS_IP='100.64.0.10'
LAB_ADMIN='labadmin'
MACHINE_NAME='Lab A - PC 01'
PASSWORD_LENGTH='8'
```

Replace examples with the real tailnet values. The endpoint requires Ubuntu
Desktop, PAM, Polkit, systemd, OpenSSH Server, `curl`, `sudo`, `keyctl`, util-linux
IPC tools, and Tailscale. Verify bidirectional tailnet reachability before
installation.

On Ubuntu, install the packaged prerequisites and start administrator SSH before
changing its policy:

```sh
sudo apt update
sudo apt install --yes curl keyutils openssh-server policykit-1 sudo util-linux
sudo systemctl enable --now ssh
tailscale status
tailscale ip -4
command -v chage chfn chsh ipcrm ipcs keyctl passwd pkaction pkcheck ssh-keygen sync
pkaction --version
pkaction >/dev/null
sudo test -d /etc/polkit-1/rules.d
sudo test ! -L /etc/polkit-1/rules.d
test "$(sudo stat -c %U:%G /etc/polkit-1/rules.d)" = root:root
test -z "$(sudo find /etc/polkit-1/rules.d -maxdepth 0 -perm /022 -print)"
test -f /etc/pam.d/chfn && test ! -L /etc/pam.d/chfn
test -f /etc/pam.d/chsh && test ! -L /etc/pam.d/chsh
test -f /etc/pam.d/passwd && test ! -L /etc/pam.d/passwd
sudo test -f /etc/ssh/ssh_host_ed25519_key.pub
sudo test ! -L /etc/ssh/ssh_host_ed25519_key.pub
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

`faillock`, `pam_tally2`, and `pam_tally` are conditional rather than universal
prerequisites: if the selected PAM auth include graph names one of their modules,
the same-named command must be installed before setup. Setup fails with the exact
missing command instead of assuming a counter can be reset.

Install/join Tailscale through the institution's approved method if it is not yet
present, then test Pi-to-endpoint and endpoint-to-Pi reachability.

The three account-change PAM files are mandatory. Setup prepends a root-owned
helper that denies non-root `guest` self-service password, shell, and GECOS
changes while allowing root maintenance.

The complete global sudoers policy and all includes must be valid before
enrollment. Setup then runs `sudo -n -l -U guest` as root with `LC_ALL=C` and
accepts only exit `0` plus exactly one output line matching
`User guest is not allowed to run sudo on <host>.`. A nonzero exit, warning,
additional line, or allow-list is ambiguous and fails setup. LabGate deliberately
does not install a guest sudo deny line because another sudoers rule could
override it.

The Polkit rule is a separate universal guest boundary. It returns `NO` for every
action when the Polkit subject user is exactly `guest`, with no branch for root,
administrators, or `provisioner`. Compatibility caveat: the shared guest loses
all privileged desktop broker actions, including any system settings, device,
package, network, time, power, or linger operation that requires Polkit. Perform
such maintenance from an administrator identity; do not add guest exceptions.

The supported primary display-manager password stacks are
`/etc/pam.d/gdm-password`, `/etc/pam.d/lightdm`, and `/etc/pam.d/sddm`. Setup
denies `guest` in known alternate authentication paths (GDM autologin,
fingerprint, and smart-card; LightDM autologin; SDDM autologin), rejects an
unknown matching manager PAM path for review, and refuses a selected auth include
graph containing `pam_fprintd.so`. Do not bypass these checks with a guessed
`LABGATE_PAM_FILE`.

The same recursively validated auth graph is inspected for `pam_faillock.so`,
`pam_tally2.so`, and `pam_tally.so`. If a module is present, its matching reset
command is mandatory; setup records the canonical list in
`/etc/labgate/auth-failure-backends`. Before each credential unlock,
`guest-account.sh` sets minimum age 0, unlimited maximum age, warning 0, no
inactive/absolute expiry, verifies the shadow aging fields, and resets every
detected counter. Failure keeps `guest` locked and fails provisioning. This
prevents an old student's failed attempts or a distro password-aging default from
making a newly issued password unusable.

The infrastructure `provisioner` identity must already exist and be non-root,
with a unique UID and a real root-owned home outside `/home/guest` that is not
group/world-writable. Bootstrap it with a verified `nologin` shell and no
authorized key. The root-owned home prevents the identity from controlling shell
startup files. Setup immediately reapplies `nologin`, terminates old real/effective
UID processes, installs and validates the dispatcher/sudoers/live ForceCommand,
and only then changes the shell to `/bin/sh`. Its `.ssh` child becomes
provisioner-owned only after setup succeeds. Setup locks and verifies the
`provisioner` shadow password and installs physical display-manager, `login`, and
`su` PAM account denials for that identity; it deliberately does not add that
denial to `/etc/pam.d/sshd`, where the forced public-key transport must continue
to work. The private key remains on the Pi.

The endpoint Ed25519 public host key is a machine identity input, not merely an
SSH implementation detail. Setup accepts only a root-controlled regular
`/etc/ssh/ssh_host_ed25519_key.pub` whose `ssh-keygen -lf ... -E sha256` result is
one canonical `SHA256:` value with a 43-character unpadded Base64 digest and an
`(ED25519)` type. First registration sends this pin with the canonical name and
Tailscale address, then stores it in `/etc/labgate/ssh-host-key-sha256`. Normal
updates compare the live key to that root-only marker before changing privileged
policy. An existing token without a marker, or any key mismatch, fails setup and
requires the drained rekey procedure; never delete the token to force a POST.

On a new endpoint, create that infrastructure identity declaratively:

```sh
NOLOGIN=$(command -v nologin)
NOLOGIN_TARGET=$(readlink -f -- "$NOLOGIN")
test -n "$NOLOGIN" && test -n "$NOLOGIN_TARGET"
sudo test -f "$NOLOGIN_TARGET"
sudo test ! -L "$NOLOGIN_TARGET"
sudo test -x "$NOLOGIN_TARGET"
test "$(sudo stat -c %u -- "$NOLOGIN_TARGET")" -eq 0
test -z "$(sudo find "$NOLOGIN_TARGET" -maxdepth 0 -perm /022 -print)"
sudo install -d -o root -g root -m 0755 /etc/sysusers.d
printf 'u provisioner - "LabGate SSH provisioner" /var/lib/labgate-provisioner %s\n' \
  "$NOLOGIN" | sudo tee /etc/sysusers.d/labgate-provisioner.conf >/dev/null
sudo systemd-sysusers /etc/sysusers.d/labgate-provisioner.conf
sudo install -d -o root -g root -m 0755 /var/lib/labgate-provisioner
sudo chsh --shell "$NOLOGIN" provisioner
sudo passwd -l provisioner
getent passwd provisioner
test "$(getent passwd provisioner | awk -F: '{ print $7 }')" = "$NOLOGIN"
sudo passwd --status provisioner | awk '$2 == "L" || $2 == "LK" { ok=1 } END { exit !ok }'
sudo test ! -e /var/lib/labgate-provisioner/.ssh/authorized_keys
```

### Transfer committed artifacts

Run from the Pi's freshly pulled `~/LabGate` checkout:

```sh
scp secrets/provisioner_key.pub \
  "${LAB_ADMIN}@${LAB_TS_IP}:/tmp/labgate-provisioner.pub"
scp -r machine-setup \
  "${LAB_ADMIN}@${LAB_TS_IP}:/tmp/labgate-machine-setup"
```

The public key is only staged under the administrator's `/tmp`; do not install it
as `authorized_keys` yet. Never transfer `secrets/provisioner_key`.

### First install

Connect as the existing administrator and enter an explicit root Bash shell:

```sh
sudo bash
```

Read the registration bearer without echo, then export only for this installer:

```sh
read -rsp 'Machine registration secret: ' LABGATE_REGISTRATION_SECRET
printf '\n'
export LABGATE_REGISTRATION_SECRET
export LABGATE_API_URL='http://PI_TAILSCALE_ADDRESS:3000'
export LABGATE_MACHINE_NAME='Lab A - PC 01'
export LABGATE_PASSWORD_LENGTH='8'
bash /tmp/labgate-machine-setup/setup-machine.sh
unset LABGATE_REGISTRATION_SECRET
exit
```

When no existing token plus matching host-pin marker is present, a missing,
short, malformed, whitespace-containing, or otherwise invalid registration
bearer fails before setup changes either account, PAM, or SSH policy. The
registration helper repeats the same validation immediately before its bounded
POST. A normal pinned update remains secret-free.

Expected completion ends with the machine name, Tailscale address, and exact
password length. At this point the forced command is live and the service shell
is `/bin/sh`, but no key has been authorized. Only now install the staged public
key with owner-only permissions:

```sh
sudo install -d -o provisioner -g provisioner -m 0700 \
  /var/lib/labgate-provisioner/.ssh
sudo install -o provisioner -g provisioner -m 0600 \
  /tmp/labgate-provisioner.pub \
  /var/lib/labgate-provisioner/.ssh/authorized_keys
sudo test -s /var/lib/labgate-provisioner/.ssh/authorized_keys
test "$(sudo stat -c %U:%G /var/lib/labgate-provisioner)" = root:root
test "$(sudo stat -c %a /var/lib/labgate-provisioner)" = 755
test "$(sudo stat -c %U:%G /var/lib/labgate-provisioner/.ssh)" = provisioner:provisioner
test "$(sudo stat -c %a /var/lib/labgate-provisioner/.ssh)" = 700
test "$(sudo stat -c %a /var/lib/labgate-provisioner/.ssh/authorized_keys)" = 600
test "$(getent passwd provisioner | awk -F: '{ print $7 }')" = /bin/sh
sudo passwd --status provisioner | awk '$2 == "L" || $2 == "LK" { ok=1 } END { exit !ok }'
sudo test -s /etc/labgate/ssh-host-key-sha256
test "$(sudo stat -c %U:%G /etc/labgate/ssh-host-key-sha256)" = root:root
test "$(sudo stat -c %a /etc/labgate/ssh-host-key-sha256)" = 600
sudo rm -f /tmp/labgate-provisioner.pub
```

From the Pi, prove the key cannot run an arbitrary command, then use a unique test
generation to exercise the exact dispatcher revoke path. This safe terminalizes
that test ID; retain it in the test record and never reuse it:

```sh
cd ~/LabGate
if ssh -o BatchMode=yes -o ConnectTimeout=5 \
  -i secrets/provisioner_key "provisioner@${LAB_TS_IP}" true; then
  echo 'FAILED: arbitrary provisioner command was accepted' >&2
  false
fi
TEST_CREDENTIAL_ID="bootstrap_$(openssl rand -hex 12)"
ssh -o BatchMode=yes -o ConnectTimeout=5 \
  -i secrets/provisioner_key "provisioner@${LAB_TS_IP}" \
  "sudo /usr/local/sbin/guest-account.sh revoke ${TEST_CREDENTIAL_ID}"
```

Verify all checks in the security section before checkout. Registration `POST`
binds the chosen name, canonical `tailscale ip -4` value, and computed Ed25519
host-key pin; later identity, pin, or
token change requires the explicit drained rekey workflow below. A newly inserted
row begins `offline` with `last_heartbeat = NULL`; installer completion alone does
not make it assignable. An exact idempotent registration replay returns the same
token without changing status or heartbeat. Only the new token's strict,
internally consistent locked/session-free heartbeat may make it `available`.

### Update an installed machine

Copy the complete new `machine-setup/` directory; never update individual files
out of band. Schedule a drained maintenance window when moving from an older
protocol, changing PAM/display manager, changing password length, or reconciling
database state. A normal same-protocol rerun does not restart an already-active
`RemainAfterExit` boot-lock unit. A legacy outbox migration refuses an active or
ambiguous machine; it never silently interrupts a student session.

Run with explicit non-secret settings:

```sh
sudo env \
  LABGATE_API_URL='http://PI_TAILSCALE_ADDRESS:3000' \
  LABGATE_MACHINE_NAME='Lab A - PC 01' \
  LABGATE_PASSWORD_LENGTH='8' \
  bash /tmp/labgate-machine-setup/setup-machine.sh
```

An existing valid webhook token is preserved only when the root-only host-key pin
marker exists and exactly matches the live Ed25519 key, so normal updates do not
need the registration bearer. A pre-pin legacy token intentionally fails before
privileged policy changes; use the `expectedSshHostKeySha256: null` drained CAS
procedure below. The installer removes the known legacy PAM hook, installs
exactly one current hook in the selected display-manager stack, records that path
in `/etc/labgate/pam-file`, denies known alternate display-manager paths to
`guest`, denies physical PAM access to the password-locked `provisioner`, fails on
unknown matching paths, rejects `pam_fprintd.so` in the selected auth include
graph, detects/resets supported failure counters, validates SSH/sudoers, and
enables all required units.

#### Bounded guest persistence cleanup

Every secure issue-preparation, revoke, PAM close/failure, cleanup, heartbeat
no-state proof, outbox migration, and boot-lock flow first locks the account,
removes linger, and terminates both real- and effective-UID guest processes. It
then clears only these reviewed shared-UID persistence surfaces:

- the exact `/run/user/<guest UID>` tree, after unmounting it if necessary;
- entries owned by the guest UID on `/dev/mqueue`;
- System V message queues, shared-memory segments, and semaphore arrays whose
  creator or current owner is the guest UID;
- the guest's kernel persistent keyring;
- the exact `/var/mail/guest` and `/var/spool/mail/guest` paths, after resolving
  only the standard two mailbox directories; and
- guest-owned entries on the separate `/tmp`, `/var/tmp`, and `/dev/shm` mounts.

PAM open repeats the clear, mounts a new `/home/guest` tmpfs, and recreates the
exact runtime directory with guest UID/GID and mode `0700`. Any command error,
unsafe parent/symlink, remaining object, nested mount that cannot be removed, or
failed verification makes the safety transaction fail. Later heartbeat/recovery
must not serialize that state as safe.

This is intentionally not a filesystem-wide UID scan. The installation also
denies guest sudo, SSH, Polkit, persistent account changes, cron/at, and linger,
and requires a dedicated UID/GID; administrators must not grant `guest` a new
persistent writable directory, service, device broker, container runtime, or
shared group without extending this threat model and acceptance suite. Use an
administrator identity for persistent lab content.

#### Migrate a legacy clock-named outbox

New events are named `event-v2-` followed by an 18-digit persistent sequence.
The known legacy form is `event-<clock>-<pid>-<six-alnum>`. Never rename old
events into the new namespace: clock rollback can put a later close before an
earlier open, and a guessed rename would make that ambiguity permanent.

Setup inventories every active outbox entry before changing privileged policy.
It fails on an unknown filename, symlink, non-`root:root 0600` event, malformed
payload, corrupt sequence, corrupt migration journal, or legacy event without an
explicit opt-in. Preserve such a failure exactly; do not delete the head event to
make setup or the timer green.

For the one-time known-format migration:

1. Remove the endpoint from student service and let any physical user log out.
2. Run immediate boot-lock recovery and prove the account is locked, no real- or
   effective-UID guest process or logind session exists, and `/home/guest` is not
   mounted. The migration deliberately refuses to lock an apparently active
   endpoint on the operator's behalf.
3. Record filenames, hashes, ownership, and modes without printing bearer files.
   Make a root-only copy of `/var/lib/labgate/outbox` for incident evidence.
4. Run the complete committed setup with the extra exact flag:

   ```sh
   sudo systemctl restart guest-boot-lock.service
   sudo env \
     LABGATE_API_URL='http://PI_TAILSCALE_ADDRESS:3000' \
     LABGATE_MACHINE_NAME='Lab A - PC 01' \
     LABGATE_PASSWORD_LENGTH='8' \
     LABGATE_MIGRATE_LEGACY_OUTBOX='1' \
     bash /tmp/labgate-machine-setup/setup-machine.sh
   ```

The installer disables and stops the old flush worker, takes the lifecycle and
worker locks, revalidates the stable queue, and writes
`/var/lib/labgate/outbox-legacy-migration` before any compaction. It then proves
dormancy again, completes local secure cleanup, records tombstones, and appends
one idempotent `session-close` version-3 event for every unique journal, legacy,
or current-state credential ID. Only after every terminal event is durable does
it move remaining legacy files to a root-only
`/var/lib/labgate/legacy-outbox-archive.*` directory and remove the journal. It
does not replay ambiguous historical opens and closes.

If power or setup fails, keep the endpoint drained. The persistent journal is
authoritative even if an old event was already delivered or archived; rerunning
the same flagged setup safely appends idempotent terminal reports. The timer is
left disabled after a failed migration so a reboot cannot resume unsafe replay.
Do not manually remove the journal, archive, sequence, or legacy files.

After success, require all of the following before restoring service:

```sh
sudo test ! -e /var/lib/labgate/outbox-legacy-migration
sudo test -z "$(sudo find /var/lib/labgate/outbox -maxdepth 1 -type f \
  -name 'event-[0-9]*' -print -quit)"
sudo find /var/lib/labgate/outbox -maxdepth 1 -type f \
  -name 'event-v2-[0-9]*' -print | sort
sudo stat -c '%U:%G %a %s %n' /var/lib/labgate/outbox-sequence
sudo systemctl is-enabled guest-webhook-flush.timer
sudo systemctl is-active guest-webhook-flush.timer
```

Verify the version-3 reports drain, the Pi has no current credential or safety
hold for the machine, and a fresh strict safe heartbeat—not setup itself—returns
the endpoint to `available`. Retain the archive until the maintenance evidence
retention window closes.

### Drained machine identity or token rekey

Registration `POST` remains immutable. Repeating the exact canonical name,
Tailscale address, and Ed25519 SHA256 host-key pin is idempotent and returns the existing token without changing
status, heartbeat, identity, or other state; a partial identity match returns
`409` without mutation. A new identity starts offline with null heartbeat and
must pass the authenticated strict safe-heartbeat gate. POST never renames,
moves, merges, rotates, or prematurely enables a row.

The authenticated `PATCH /api/admin/register-machine` is the only supported
identity/token-change path. It requires all of:

- the existing machine ID;
- its exact current name, canonical Tailscale CGNAT IPv4 address, and host-key pin
  as compare-and-swap values. A legacy migrated null pin must be represented only
  as JSON `expectedSshHostKeySha256: null`;
- the replacement name, canonical current Tailscale address, and canonical local
  Ed25519 host-key pin;
- database status `available`; and
- no current (`revoked_at IS NULL`) credential; and
- `safety_hold_credential_id IS NULL`.

Success atomically changes identity and the host-key pin, rotates the webhook token, clears
`last_heartbeat`, writes a `machine_rekey` audit event, and holds the row
`offline`. The old token stops authenticating immediately. Treat the returned
replacement token as a one-time handoff: capture the response in a root-only
file, never terminal output, argv, logs, or shell history. Only a subsequent
locked, session-free heartbeat authenticated by the new token may release the
offline hold.

#### Rekey procedure

1. Block student ingress at the reverse proxy while retaining a root/operator
   path to the API. Drain the endpoint and run boot-lock recovery. Prove the guest
   is locked, no guest session/process exists, no tmpfs is mounted, server status
   is `available`, no current credential exists, and
   `safety_hold_credential_id` is null. If checkout or a safety report wins a
   race, the transactional `PATCH` returns `409`; drain/reconcile again rather
   than overriding it.
2. Back up SQLite and the endpoint's root-only `/etc/labgate` directory. Record
   hashes/metadata, not token contents. Confirm the replacement IP is the exact
   output of `tailscale ip -4` and does not conflict with another row. Stage the
   complete committed `machine-setup/` directory on the endpoint for the later
   installer rerun; do not use a stale or partial copy. Determine whether the
   current database pin is the exact persisted marker or legacy `NULL`; do not
   infer null merely because a local file is missing.
3. On the endpoint, enter an explicit root Bash shell and make an ephemeral
   root-only workspace. Keep a copy of the old webhook curl config only for the
   post-rotation rejection probe:

   ```sh
   sudo bash
   set -euo pipefail
   umask 077
   install -d -o root -g root -m 0700 /run/labgate-rekey
   cp --preserve=mode /etc/labgate/webhook-curl.conf \
     /run/labgate-rekey/old-webhook-curl.conf
   install -o root -g root -m 0600 /dev/null \
     /run/labgate-rekey/registration-curl.conf
   install -o root -g root -m 0600 /dev/null \
     /run/labgate-rekey/request.json
   bash -c '
     source /tmp/labgate-machine-setup/labgate-common.sh
     labgate_compute_ssh_host_key_sha256
   ' >/run/labgate-rekey/ssh-host-key-sha256.new
   test "$(wc -l </run/labgate-rekey/ssh-host-key-sha256.new)" -eq 1
   grep -Eq '^SHA256:[A-Za-z0-9+/]{43}$' \
     /run/labgate-rekey/ssh-host-key-sha256.new
   ${EDITOR:-vi} /run/labgate-rekey/registration-curl.conf
   ${EDITOR:-vi} /run/labgate-rekey/request.json
   ```

   Enter these structures only inside the editors. The bearer accepts RFC 6750
   `b64token`, including `+`, `/`, and trailing `=`:

   ```text
   header = "Authorization: Bearer REPLACE_IN_EDITOR"
   header = "Content-Type: application/json"
   ```

   ```json
   {"machineId":"CURRENT_ID","expectedName":"CURRENT_NAME","expectedTailscaleIp":"CURRENT_IP","expectedSshHostKeySha256":"CURRENT_SHA256_PIN","name":"REPLACEMENT_NAME","tailscaleIp":"REPLACEMENT_IP","sshHostKeySha256":"VALUE_FROM_SSH_HOST_KEY_SHA256_NEW"}
   ```

   For the one-time migration of a database row whose pin is actually SQL
   `NULL`, use the JSON value `null` (without quotes) for
   `expectedSshHostKeySha256`. That exact null compare-and-swap is the only
   supported legacy claim. For an already pinned row, use its exact current
   string. The replacement field is always the non-null value computed into
   `ssh-host-key-sha256.new`. Review the JSON with a second operator; a wrong pin
   will intentionally make later SSH provisioning fail closed.

4. Still in the root shell, send files rather than secrets/JSON in arguments and
   save the response without displaying it:

   ```sh
   API_URL=$(cat /etc/labgate/api-url)
   curl --config /run/labgate-rekey/registration-curl.conf \
     --fail --silent --show-error --connect-timeout 3 --max-time 10 \
     --request PATCH \
     --data-binary @/run/labgate-rekey/request.json \
     --output /run/labgate-rekey/response.json \
     --url "${API_URL}/api/admin/register-machine"
   sed -n \
     's/.*"webhookToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
     /run/labgate-rekey/response.json \
     >/run/labgate-rekey/webhook-token.new
   IFS= read -r NEW_TOKEN </run/labgate-rekey/webhook-token.new
   [[ $NEW_TOKEN =~ ^[A-Za-z0-9_-]{32,128}$ ]]
   unset NEW_TOKEN
   ```

5. Prove the old token now receives `401` without printing it. The body is only
   an authentication probe and cannot mutate because authentication fails:

   ```sh
   printf '%s\n' \
     '{"credentialId":null,"guestLocked":true,"sessionActive":false,"state":null,"stateVersion":null}' \
     >/run/labgate-rekey/auth-probe.json
   OLD_STATUS=$(curl \
     --config /run/labgate-rekey/old-webhook-curl.conf \
     --silent --output /dev/null --write-out '%{http_code}' \
     --connect-timeout 3 --max-time 10 --request POST \
     --data-binary @/run/labgate-rekey/auth-probe.json \
     --url "${API_URL}/api/webhook/heartbeat")
   test "$OLD_STATUS" = 401
   unset OLD_STATUS
   ```

6. Install the replacement pin marker and token root-only, in that order, rerun the complete committed setup
   with the replacement name and actual current address, then force a locally safe
   heartbeat. No registration bearer is needed because the token file now exists:

   ```sh
   install -o root -g root -m 0600 \
     /run/labgate-rekey/ssh-host-key-sha256.new \
     /etc/labgate/ssh-host-key-sha256
   install -o root -g root -m 0600 \
     /run/labgate-rekey/webhook-token.new /etc/labgate/webhook-token
   LABGATE_API_URL="$API_URL" \
   LABGATE_MACHINE_NAME='REPLACEMENT_NAME' \
   LABGATE_PASSWORD_LENGTH="$(cat /etc/labgate/password-length)" \
     bash /tmp/labgate-machine-setup/setup-machine.sh
   systemctl restart guest-boot-lock.service
   systemctl start guest-heartbeat.service
   rm -rf /run/labgate-rekey
   exit
   ```

7. On the Pi, verify the same machine ID now has the replacement identity and
   exact expected `ssh_host_key_sha256`,
   `last_heartbeat` is non-null, `safety_hold_credential_id` remains null, status
   became `available` only after the safe heartbeat, and exactly one expected
   `machine_rekey` audit event exists. Repeat
   SSH/PAM/dormant-safe checks and the rekey E2E case before restoring student
   ingress.

#### Interrupted rekey and rollback

- If `PATCH` returns an error, it makes no partial identity/token change. Preserve
  the response only as restricted incident evidence, correct the precondition,
  and retry.
- Once `PATCH` succeeds, the old token is invalid and the database intentionally
  remains `offline`; do not reinstall the old token or manually set `available`.
  Restore endpoint access and finish the new-token handoff.
- If the one-time response was lost, an authenticated exact-triple `POST` using the
  new identity can recover the already-stored token into the same root-only file.
  It does not rotate the token. Keep the machine offline throughout.
- If the replacement identity or pin was wrong, first install/recover its token and
  obtain a safe heartbeat. Once the row is again `available` with no current
  credential and no safety hold, perform another reviewed `PATCH` using the
  replacement as the exact expected identity and the desired identity as the next
  replacement. This rotates the token again and repeats the offline gate.
- Restoring a Pi database backup may restore an older identity/token. Stop the app,
  fail-safe secure the endpoint, and reconcile both sides before restart; never
  reopen checkout with split identity/token state.

### Installed artifact inventory

| Installed path | Owner/mode | Purpose |
|---|---|---|
| `/etc/sysusers.d/labgate-guest.conf` | `root:root 0644` | Declarative initial shared-account definition |
| `/etc/polkit-1/rules.d/00-labgate-deny-guest.rules` | `root:root 0644` | Exact committed universal Polkit denial for the guest subject only |
| `/usr/local/lib/labgate/labgate-common.sh` | `root:root 0600` | Shared lifecycle lock/state/safety primitives |
| `/usr/local/sbin/guest-*.sh` | `root:root 0700` | Issue/revoke, PAM, cleanup, heartbeat, outbox, and boot actions |
| `/usr/local/sbin/labgate-deny-guest-account-change.sh` | `root:root 0755` | PAM helper denying non-root guest password/shell/GECOS changes |
| `/usr/local/sbin/labgate-provisioner-dispatch.sh` | `root:root 0755` | POSIX `/bin/sh` forced-command parser using fixed `/usr/bin/sudo` |
| `/etc/sudoers.d/labgate-guest-provision` | `root:root 0440` | Single-script sudo boundary |
| `/etc/systemd/system/guest-*` | `root:root 0644` | Boot lock, cleanup, heartbeat, and outbox units |
| `/etc/labgate/auth-failure-backends` | `root:root 0600` | Canonical selected-PAM failure counters reset before issue |
| `/etc/labgate/ssh-host-key-sha256` | `root:root 0600` | Non-secret canonical Ed25519 host-key pin paired with registration |
| Other `/etc/labgate/*` | `root:root 0600` | API URL, PAM path, password length, and bearer configuration |
| `/var/lib/labgate`, `outbox/`, and `tombstones/` | `root:root 0700` | Persistent state, recovery marker, ordered events, and terminal generation tombstones |
| `/etc/ssh/sshd_config.d/99-labgate-guest.conf` | `root:root 0644` | Guest SSH denial |

The installer also maintains a tagged `Match User provisioner` forced-command
block in `/etc/ssh/sshd_config` and validates the entire SSH configuration before
reload. A validation failure restores the previous SSH configuration.

### Polkit, sudo, and linger boundary

Validate the installed policy against the complete committed artifact copied for
this maintenance window:

```sh
POLKIT_SOURCE=/tmp/labgate-machine-setup/00-labgate-deny-guest.rules
sudo test -f /etc/polkit-1/rules.d/00-labgate-deny-guest.rules
sudo test ! -L /etc/polkit-1/rules.d/00-labgate-deny-guest.rules
test "$(sudo stat -c %U:%G /etc/polkit-1/rules.d/00-labgate-deny-guest.rules)" = root:root
test "$(sudo stat -c %a /etc/polkit-1/rules.d/00-labgate-deny-guest.rules)" = 644
sudo cmp -s "$POLKIT_SOURCE" /etc/polkit-1/rules.d/00-labgate-deny-guest.rules
sudo env LC_ALL=C sudo -n -l -U guest
sudo test ! -e /var/lib/systemd/linger/guest
sudo test ! -L /var/lib/systemd/linger/guest
```

The sudo command must print only the single no-grants sentence described in the
prerequisites and exit zero. The committed Polkit function returns no value for
all non-guest subjects, so it neither grants nor denies root, administrator, or
`provisioner`; retain their pre-install behavior as E19 evidence.

Every issue preparation, revoke, PAM close/fail-safe, cleanup, and boot recovery
best-effort calls `loginctl disable-linger guest`, then removes and verifies
`/var/lib/systemd/linger/guest` before process cleanup. The explicit file removal
is authoritative even if logind is unavailable. If the marker cannot be removed,
the script still attempts lock, process termination, scratch cleanup, and unmount,
but returns a local safety failure. Keep the endpoint quarantined, repair the
root-controlled linger path, rerun boot-lock recovery, and prove it absent; never
mark the machine available around the failure.

## PAM inspection, enable, reset, and disable

### Inspect

Determine the configured display manager and installed PAM path:

```sh
systemctl show display-manager.service --property=FragmentPath --value
sudo cat /etc/labgate/pam-file
sudo cat /etc/labgate/auth-failure-backends
sudo grep -RFnx -- \
  'session required pam_exec.so quiet /usr/local/sbin/guest-session-hook.sh' \
  /etc/pam.d
sudo grep -Fnx -- \
  'account requisite pam_succeed_if.so quiet user != guest' \
  /etc/pam.d/login /etc/pam.d/su /etc/pam.d/su-l
sudo grep -Fnx -- \
  'account requisite pam_succeed_if.so quiet user != provisioner' \
  "$(sudo cat /etc/labgate/pam-file)" \
  /etc/pam.d/login /etc/pam.d/su /etc/pam.d/su-l
sudo grep -Fnx -- \
  'auth requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh' \
  /etc/pam.d/chfn /etc/pam.d/chsh
sudo grep -Fnx -- \
  'password requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh' \
  /etc/pam.d/passwd
sudo stat -c '%U:%G %a %n' \
  /usr/local/sbin/labgate-deny-guest-account-change.sh \
  /etc/labgate/auth-failure-backends
sudo passwd --status provisioner
sudo chage --list guest
PAM_FILE=$(sudo cat /etc/labgate/pam-file)
case "$(basename -- "$PAM_FILE")" in
  gdm-password)
    PREFIX=gdm
    KNOWN='gdm-password gdm-autologin gdm-fingerprint gdm-smartcard gdm-launch-environment'
    ALTERNATES='gdm-autologin gdm-fingerprint gdm-smartcard'
    ;;
  lightdm)
    PREFIX=lightdm
    KNOWN='lightdm lightdm-autologin lightdm-greeter'
    ALTERNATES='lightdm-autologin'
    ;;
  sddm)
    PREFIX=sddm
    KNOWN='sddm sddm-autologin sddm-greeter'
    ALTERNATES='sddm-autologin'
    ;;
  *) echo "Unsupported selected PAM stack: $PAM_FILE" >&2; false ;;
esac
for candidate in /etc/pam.d/${PREFIX}*; do
  test -e "$candidate" || continue
  candidate_name=$(basename -- "$candidate")
  case " $KNOWN " in
    *" $candidate_name "*) ;;
    *) echo "Unknown display-manager PAM path: $candidate" >&2; false ;;
  esac
done
for alternate in $ALTERNATES; do
  test -e "/etc/pam.d/$alternate" || continue
  sudo grep -Fnx -- \
    'account requisite pam_succeed_if.so quiet user != guest' \
    "/etc/pam.d/$alternate"
  sudo grep -Fnx -- \
    'account requisite pam_succeed_if.so quiet user != provisioner' \
    "/etc/pam.d/$alternate"
done
```

Exactly one current session hook must exist, in the recorded display-manager
file. The older spelling without `quiet` must not exist. Each account-change
line must exist exactly once, and the helper must be a root-owned mode-0755
regular file. Keep both an administrator SSH connection and physical console
available while inspecting. The PAM line intentionally omits `seteuid`: the
helper checks the real UID of the caller so non-root guest self-service is denied
while explicit root maintenance succeeds.

Every present known alternate authentication path must contain the guest-denial
line, and no unknown matching manager path may exist. The installer recursively
validates the selected stack's `auth` include graph and fails if it finds
`pam_fprintd.so`; a simple grep of only the primary file is not equivalent proof.
The primary and every present alternate plus `login`/`su` path must contain the
provisioner account denial, and `passwd --status provisioner` must report `L` or
`LK`. The selected backend file must be one canonical ordered combination of
`faillock`, `pam_tally2`, and `pam_tally`, or exactly `none`; each named command
must exist. `chage --list guest` must show no password or account expiry, minimum
days 0, and warning days 0.
Rerun the current installer in a drained window whenever the PAM include graph
changes.

Do not invoke `guest-session-hook.sh` manually with fabricated PAM variables.
Its ownership marker binds open and close to one real PAM transaction. Use a
physical login/logout or the boot-lock recovery procedure.

### Enable or move to a new display manager

Drain the machine and confirm local safe state. Only GDM `gdm-password`, LightDM
`lightdm`, and SDDM `sddm` are currently classified. Set `LABGATE_PAM_FILE` only
to the appropriate supported primary stack after reviewing it, then rerun the
complete installer. It removes known LabGate session-hook lines from other PAM
files, proves exactly one current line remains, installs denials on known
alternate paths, validates the auth include graph, and fails on unknown manager
paths. A different display manager requires a committed installer change and
security review before use, not an override guessed in production.

### Reset damaged or duplicated PAM integration

1. Remove the machine from student use and close the physical guest session.
2. Run boot-lock recovery and verify dormant-safe state.
3. Back up every LabGate-managed PAM file with metadata:

   ```sh
   PAM_FILE=$(sudo cat /etc/labgate/pam-file)
   PAM_BACKUP="/root/labgate-pam-before-reset-$(date +%Y%m%d-%H%M%S)"
   sudo install -d -o root -g root -m 0700 "$PAM_BACKUP"
   sudo cp -a "$PAM_FILE" \
     /etc/pam.d/chfn /etc/pam.d/chsh /etc/pam.d/passwd \
     "$PAM_BACKUP/"
   for optional in \
     /etc/pam.d/login /etc/pam.d/su /etc/pam.d/su-l \
     /etc/pam.d/gdm-autologin /etc/pam.d/gdm-fingerprint \
     /etc/pam.d/gdm-smartcard /etc/pam.d/lightdm-autologin \
     /etc/pam.d/sddm-autologin; do
     if test -f "$optional" && test ! -L "$optional"; then
       sudo cp -a "$optional" "$PAM_BACKUP/"
     fi
   done
   ```

4. Rerun `setup-machine.sh` with the reviewed `LABGATE_PAM_FILE`. The installer
   removes both known spellings across `/etc/pam.d`, prepends one current hook,
   reinstalls the root-owned account-change helper, deduplicates the exact
   login/shell/GECOS/password protections, locks `provisioner`, reinstalls its
   physical PAM denials, redetects failure counters, restores non-expiring guest
   aging, and resets the counters.
5. Repeat every inspection command above. Also prove a non-root call for
   `PAM_USER=guest` is denied while the same pure helper check as root succeeds:

   ```sh
   test "$(id -u)" -ne 0
   if env PAM_USER=guest \
     /usr/local/sbin/labgate-deny-guest-account-change.sh; then
     echo 'FAILED: non-root guest account change was allowed' >&2
     false
   fi
   sudo env PAM_USER=guest \
     /usr/local/sbin/labgate-deny-guest-account-change.sh
   ```

6. Keep the backup until a full physical login/logout test passes.

If the login stack breaks, use the still-open administrator session or physical
recovery console to restore the backup, then investigate before retrying.

### Temporarily disable the display-manager hook

This is a maintenance/decommission action, not a way to keep offering the
machine without cleanup.

1. Stop new checkout traffic and drain the physical session.
2. Run boot-lock recovery and prove dormant-safe state.
3. Back up the PAM file.
4. Remove only the two exact LabGate session-hook spellings from the recorded
   display-manager file. Keep the console-access and SSH-denial protections.
5. Stop heartbeat/cleanup/outbox timers if decommissioning, but keep boot lock
   enabled until the endpoint is rebuilt or its credential state is reconciled.
6. Ensure the Pi no longer presents the endpoint to students before returning
   any general-purpose use.

Re-enable only by rerunning the committed installer and completing the physical
E2E matrix.

After the backup, the exact hook-removal command is:

```sh
PAM_FILE=$(sudo cat /etc/labgate/pam-file)
sudo sed -i \
  -e '\|^session required pam_exec[.]so quiet /usr/local/sbin/guest-session-hook[.]sh$|d' \
  -e '\|^session required pam_exec[.]so /usr/local/sbin/guest-session-hook[.]sh$|d' \
  "$PAM_FILE"
sudo grep -RFn -- '/usr/local/sbin/guest-session-hook.sh' /etc/pam.d
sudo systemctl disable --now \
  guest-cleanup.timer guest-heartbeat.timer guest-webhook-flush.timer
```

The final grep must show no display-manager session hook. Do not remove the
guest SSH denial, forced provisioner dispatcher, or boot-lock service during
temporary maintenance.

### Fully remove LabGate PAM integration

Use only after the endpoint is drained, fail-safe secured, quarantined on the Pi,
and removed from student service. Back up all PAM files as in reset, then remove
only these exact LabGate lines:

```sh
PAM_FILE=$(sudo cat /etc/labgate/pam-file)
sudo sed -i \
  -e '\|^session required pam_exec[.]so quiet /usr/local/sbin/guest-session-hook[.]sh$|d' \
  -e '\|^session required pam_exec[.]so /usr/local/sbin/guest-session-hook[.]sh$|d' \
  "$PAM_FILE"
for file in /etc/pam.d/chfn /etc/pam.d/chsh; do
  sudo sed -i \
    '\|^auth requisite pam_exec[.]so quiet /usr/local/sbin/labgate-deny-guest-account-change[.]sh$|d' \
    "$file"
done
sudo sed -i \
  '\|^password requisite pam_exec[.]so quiet /usr/local/sbin/labgate-deny-guest-account-change[.]sh$|d' \
  /etc/pam.d/passwd
sudo grep -RFn \
  -e '/usr/local/sbin/guest-session-hook.sh' \
  -e '/usr/local/sbin/labgate-deny-guest-account-change.sh' \
  -- /etc/pam.d
sudo rm -f /usr/local/sbin/labgate-deny-guest-account-change.sh
```

The grep must print no reference before deleting the helper. Keep the
console-login denial lines, guest SSH denial, and boot lock until the locked
shared identity is deliberately retired through a separate reviewed process.

## Manual issue, revoke, and recovery

Manual lifecycle calls are for an isolated test machine during maintenance. They
must use the current exact generation.

### Issue a test generation locally

Confirm no physical guest session exists and current state is absent or revoked.
Generate a shell-safe ID and future deadline, then read an exact-length test
password without echo:

```sh
CREDENTIAL_ID="manual_$(openssl rand -hex 12)"
EXPIRES_AT_UNIX=$(( $(date +%s) + 180 ))
read -rsp 'Exact-length test password: ' PASSWORD
printf '\n'
printf '%s\n' "$PASSWORD" | \
  sudo /usr/local/sbin/guest-account.sh \
    issue "$CREDENTIAL_ID" "$EXPIRES_AT_UNIX"
unset PASSWORD
```

The password must use the allowed unambiguous characters and exactly match
`/etc/labgate/password-length`. Exactly one newline-terminated line is accepted;
missing input, an extra line, or malformed content fails. The password is stdin,
not a script/sudo argument. The command writes pending/version 1 state but does
not persist the password. The deadline must be no more than 24 hours plus the
fixed 60-second skew allowance ahead of the machine clock. Before rotation and
unlock, the command verifies non-expiring guest aging and resets every backend in
`/etc/labgate/auth-failure-backends`; a failure leaves the account locked.

### Revoke the same pending generation

```sh
sudo /usr/local/sbin/guest-account.sh revoke "$CREDENTIAL_ID"
sudo systemctl start guest-webhook-flush.service
sudo systemctl start guest-heartbeat.service
```

Revoke refuses a real active session and refuses to replace a different pending
generation. If issuance failed before pending state existed—or current state is a
different already-revoked generation—it securely locks and records the requested
ID as terminal/revoked version 3 with a persistent tombstone. That compensation
ID can never be issued later. For an active session, use orderly physical logout;
for emergency containment, use boot-lock recovery.

### Immediate fail-safe recovery

This deliberately ends any guest workload:

```sh
sudo systemctl restart guest-boot-lock.service
sudo systemctl start guest-cleanup.service
sudo systemctl start guest-webhook-flush.service
sudo systemctl start guest-heartbeat.service
```

Boot lock locks locally first, disables and removes guest linger, terminates
guest-owned processes, clears the bounded runtime/scratch/IPC/keyring/mailbox
surfaces, unmounts the tmpfs, clears the PAM marker, and advances valid state to
revoked/version 3.
Do not mark the machine available manually; wait for the exact-generation
heartbeat or queued terminal event to reconcile the Pi.

### Reconcile a server safety hold

`machines.safety_hold_credential_id` is a persistent server quarantine, not a
display-only diagnostic. It records the physical generation that contradicted or
outlived database state. Because that generation may be unknown to the database,
the column deliberately has no foreign key. The reserved internal marker
`__unsafe_without_credential__` means the endpoint was unlocked without reporting
any generation ID.

Inspect holds and current rows on the Pi without exposing any bearer:

```sh
sqlite3 -header -column data/labgate.db <<'SQL'
SELECT machine.id,
       machine.name,
       machine.tailscale_ip,
       machine.status,
       machine.safety_hold_credential_id,
       credential.id AS current_credential_id,
       credential.expires_at,
       credential.machine_state_version
FROM machines AS machine
LEFT JOIN guest_credentials AS credential
  ON credential.machine_id = machine.id
 AND credential.revoked_at IS NULL
WHERE machine.safety_hold_credential_id IS NOT NULL
ORDER BY machine.name;
SQL
```

Treat full IDs as restricted correlation data. For each row:

1. Block checkout and keep status occupied. Do not clear the column or set status
   directly in SQLite.
2. Determine what created the hold:
   - an unexpected active/pending or terminal-active heartbeat terminalizes any
     current DB row because the endpoint proved another physical generation is
     authoritative;
   - the reserved conflict sentinel means the server has evidence of more than
     one physical generation (or an unsafe report without a usable ID); no
     generation-scoped close is allowed to release that quarantine;
   - an ambiguous issue plus failed compensating revoke intentionally leaves its
     same-ID row unrevoked but immediately expired so the sweep retries exact SSH
     revoke; or
   - an unlocked/no-state heartbeat uses the reserved internal marker.
3. Inspect local credential state, PAM marker, logind sessions, guest real/effective
   UID processes, mount, and lock status. If the held ID is active, prefer orderly
   physical logout. If it cannot end safely, declare disruption and run boot-lock
   recovery. If it is pending, exact-generation revoke or cleanup must lock it.
4. When local state is another generation, secure/terminalize that physical state
   first. An event for that unrelated ID is useful evidence but cannot clear the
   hold. A conflict sentinel clears only after a fresh locked, session-free,
   no-state heartbeat with no current database credential. Once the endpoint is
   confirmed session-free and locked, issue an exact
   local revoke for the held ID so persistent revoked/version-3 state and its
   tombstone are reported:

   ```sh
   HELD_ID='REPLACE_WITH_RESTRICTED_HELD_ID'
   sudo /usr/local/sbin/guest-account.sh revoke "$HELD_ID"
   sudo systemctl start guest-webhook-flush.service
   sudo systemctl start guest-heartbeat.service
   unset HELD_ID
   ```

   The lifecycle script refuses a different pending/active state or any live guest
   session, so do not bypass a failure. The reserved no-ID marker is not a physical
   credential and must not be passed to this command.
5. A genuinely absent local generation may send a fresh, globally safe locked
   no-state heartbeat only after proving locked guest, no session/process/mount,
   and no local state. It may clear a hold only when the server also has no current
   credential. Never delete or rewrite local state merely to manufacture a
   no-state report.
6. Verify the Pi cleared the exact hold and changed to `available` only if no
   current row remains. Replay a delayed version-3 close for another ID and prove
   it does not release while the hold is present. Keep all mismatches quarantined
   and escalate rather than guessing.

A fresh active heartbeat for a DB-terminal generation creates a new hold for that
same ID. This is intentional: database timestamps cannot overrule evidence that a
physical session is running. Boot-lock/orderly close must produce exact locked
version 3 before release.

## State, outbox, recovery marker, and logs

### Paths and formats

| Path | Contents |
|---|---|
| `/var/lib/labgate/credential-state` | Tab-separated generation ID, deadline, state, version, changed-at Unix time |
| `/var/lib/labgate/recovery-needed` | Timestamp, generation or `-`, and reason requiring attention |
| `/var/lib/labgate/outbox/event-v2-<18 digits>` | Ordered endpoint, generation ID, and state version; no bearer/password |
| `/var/lib/labgate/outbox-sequence` | Last allocated monotonic outbox sequence; `root:root 0600` |
| `/var/lib/labgate/outbox-legacy-migration` | Crash-recovery journal present only during an authorized legacy migration |
| `/var/lib/labgate/legacy-outbox-archive.*` | Preserved known-format legacy events after terminal compaction |
| `/var/lib/labgate/tombstones/<credential-id>` | Terminal-generation timestamp preventing later reuse, including failed-issue compensation |
| `/run/labgate/pam-session` | Volatile generation and PAM ownership marker |
| `/run/lock/labgate/guest.lock` | Lifecycle serialization lock |
| `/run/lock/labgate/outbox-sequence.lock` | Short local producer sequence lock; never held for networking |
| `/run/lock/labgate/webhook-outbox.lock` | Outbox flush serialization lock |

The corresponding server-only quarantine is
`machines.safety_hold_credential_id` in Pi SQLite. It is not copied to endpoint
state because the Pi uses it specifically when endpoint and database generations
disagree.

Inspect non-secret state and metadata:

```sh
sudo cat /var/lib/labgate/credential-state
sudo test ! -e /var/lib/labgate/recovery-needed
sudo find /var/lib/labgate/outbox -maxdepth 1 -type f -name 'event-*' -print | sort
sudo find /var/lib/labgate/tombstones -maxdepth 1 -type f -print | sort
sudo stat -c '%U:%G %a %s %n' \
  /etc/labgate/webhook-token /etc/labgate/webhook-curl.conf
```

Never print the webhook files. State version must match state exactly:
`pending=1`, `active=2`, `revoked=3`.

Tombstones contain no password or bearer and must not be deleted during routine
cleanup; deletion could permit a terminal generation ID to be issued again. An
unsafe/corrupt tombstone is a recovery condition, not a file to bypass.

The outbox flushes oldest first and stops at the first invalid or undeliverable
transport result so close cannot overtake open. A backlog during network loss is
expected; it should drain in order after connectivity returns. Fixed-width
sequence filenames sort lexically in publication order even if NTP steps the
clock backward. The allocator persists its counter before publishing an event,
so gaps are valid after a crash; it also recovers a stale lower counter from live
filenames. Never reset the counter. A corrupt counter fails publication closed.

The flush worker may hold `webhook-outbox.lock` across its bounded curl request,
but producers never acquire that lock. They use only `outbox-sequence.lock` for
short local file operations, preserving the rule that PAM and secure cleanup do
not wait for networking. To prevent a valid old event from poisoning the head,
the server transactionally records and returns
2xx for every authenticated, syntactically valid event of the endpoint's required
version—even an unknown/conflicting open or unrelated/unknown terminal close.
Its JSON status says `held`, `conflict`, or `not_found`; 4xx is reserved for auth,
malformed input, or endpoint/version mismatch. Thus an exact queued version-3
close behind an unknown open can still drain and advance reconciliation.

If the head event is corrupt, do not delete it just to make the queue green.
Stop the flush timer, run boot-lock recovery, reconcile the exact generation by
heartbeat, record the event filename/hash, quarantine it in root-only storage,
then restart the timer and verify all later events are idempotently accepted.

If `recovery-needed` exists, inspect the reason and logs, run the fail-safe
recovery, and prove local plus Pi state agree. Do not remove the marker merely to
silence monitoring.

### Logs

```sh
sudo journalctl -b -u guest-boot-lock.service
sudo journalctl \
  -u guest-cleanup.service \
  -u guest-heartbeat.service \
  -u guest-webhook-flush.service \
  --since today
sudo journalctl -t labgate --since today
```

On the Pi:

```sh
cd ~/LabGate
docker compose ps
docker compose logs --since=30m labgate
tailscale status
```

A successful heartbeat service only proves the best-effort command completed;
inspect Pi `lastHeartbeat`, state, and outbox backlog to prove delivery.
A local no-state snapshot is release-capable, so `guest-heartbeat.sh` first runs
the complete secure transaction and clears the PAM marker under the lifecycle
lock. On any safety failure it records recovery and sends no no-state heartbeat.
A corrupt state file is secured but retained and likewise never serialized as a
safe no-state snapshot.

## Timers and boot ordering

Expected schedule:

| Unit | Expected behavior |
|---|---|
| `guest-boot-lock.service` | Before user sessions, display manager, `ssh.service`, and `sshd.service`; `RemainAfterExit=yes` |
| `guest-cleanup.timer` | Boot +30 seconds, then every 30 seconds, persistent |
| `guest-heartbeat.timer` | Boot +15 seconds, then every 45 seconds |
| `guest-webhook-flush.timer` | Boot +10 seconds, then every 10 seconds, persistent |

Verify:

```sh
sudo systemctl is-enabled \
  guest-boot-lock.service guest-cleanup.timer \
  guest-heartbeat.timer guest-webhook-flush.timer
sudo systemctl is-active \
  guest-boot-lock.service guest-cleanup.timer \
  guest-heartbeat.timer guest-webhook-flush.timer
sudo systemctl list-timers --all \
  guest-cleanup.timer guest-heartbeat.timer guest-webhook-flush.timer
sudo systemd-analyze critical-chain display-manager.service
sudo systemd-analyze critical-chain ssh.service
```

After a real reboot, not merely a service restart, verify boot lock completed
before login services and that a previously pending or active password no longer
works.

## Security and dormant-safe checks

Run after install/update and during incidents:

```sh
sudo visudo -cf /etc/sudoers.d/labgate-guest-provision
sudo sshd -t
sudo sshd -T -C user=guest,host=localhost,addr=127.0.0.1 \
  | grep -F 'denyusers'
PROVISIONER_EFFECTIVE=$(sudo sshd -T \
  -C user=provisioner,host=localhost,addr=127.0.0.1)
for setting in \
  'forcecommand /usr/local/sbin/labgate-provisioner-dispatch.sh' \
  'authenticationmethods publickey' \
  'pubkeyauthentication yes' \
  'passwordauthentication no' \
  'kbdinteractiveauthentication no' \
  'hostbasedauthentication no' \
  'gssapiauthentication no' \
  'kerberosauthentication no' \
  'permitemptypasswords no' \
  'permituserrc no' \
  'permituserenvironment no' \
  'disableforwarding yes' \
  'allowagentforwarding no' \
  'allowtcpforwarding no' \
  'x11forwarding no' \
  'permittunnel no' \
  'permittty no'; do
  printf '%s\n' "$PROVISIONER_EFFECTIVE" | grep -Fqx "$setting"
done
printf '%s\n' "$PROVISIONER_EFFECTIVE" | awk '
  $1 == "acceptenv" {
    for (i = 2; i <= NF; i++)
      if ($i != "LANG" && $i !~ /^LC_[A-Za-z0-9_*?]+$/) exit 1
  }
'
PROVISIONER_HOME=$(getent passwd provisioner | awk -F: '{ print $6 }')
test "$(getent passwd provisioner | awk -F: '{ print $7 }')" = /bin/sh
sudo passwd --status provisioner | awk '$2 == "L" || $2 == "LK" { ok=1 } END { exit !ok }'
test "$(sudo stat -c %U:%G "$PROVISIONER_HOME")" = root:root
test "$(sudo stat -c %a "$PROVISIONER_HOME")" = 755
test "$(sudo stat -c %U:%G "$PROVISIONER_HOME/.ssh")" = provisioner:provisioner
test "$(sudo stat -c %a "$PROVISIONER_HOME/.ssh")" = 700
test "$(sudo stat -c %U:%G "$PROVISIONER_HOME/.ssh/authorized_keys")" = provisioner:provisioner
test "$(sudo stat -c %a "$PROVISIONER_HOME/.ssh/authorized_keys")" = 600
sudo test -x /usr/bin/sudo
sudo test -f /usr/bin/sudo
sudo test ! -L /usr/bin/sudo
test "$(sudo stat -c %u /usr/bin/sudo)" = 0
test "$(sudo head -n 1 /usr/local/sbin/labgate-provisioner-dispatch.sh)" = '#!/bin/sh'
test "$(sudo stat -c %U:%G /usr/local/sbin/labgate-provisioner-dispatch.sh)" = root:root
test "$(sudo stat -c %a /usr/local/sbin/labgate-provisioner-dispatch.sh)" = 755
sudo grep -Fnx -- \
  'auth requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh' \
  /etc/pam.d/chfn /etc/pam.d/chsh
sudo grep -Fnx -- \
  'password requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh' \
  /etc/pam.d/passwd
PAM_FILE=$(sudo cat /etc/labgate/pam-file)
sudo grep -Fnx -- \
  'account requisite pam_succeed_if.so quiet user != provisioner' \
  "$PAM_FILE" /etc/pam.d/login /etc/pam.d/su /etc/pam.d/su-l
sudo cat /etc/labgate/auth-failure-backends
sudo chage --list guest
sudo env LC_ALL=C sudo -n -l -U guest
sudo cmp -s /tmp/labgate-machine-setup/00-labgate-deny-guest.rules \
  /etc/polkit-1/rules.d/00-labgate-deny-guest.rules
test "$(sudo stat -c %U:%G /etc/polkit-1/rules.d/00-labgate-deny-guest.rules)" = root:root
test "$(sudo stat -c %a /etc/polkit-1/rules.d/00-labgate-deny-guest.rules)" = 644
sudo passwd --status guest
sudo loginctl show-user guest -p Linger
sudo test ! -e /var/lib/systemd/linger/guest
sudo test ! -L /var/lib/systemd/linger/guest
sudo findmnt --target /home/guest
sudo pgrep -a -u "$(id -u guest)"
sudo pgrep -a -U "$(id -u guest)"
GUEST_UID=$(id -u guest)
sudo test ! -e "/run/user/$GUEST_UID"
for scratch in /tmp /var/tmp /dev/shm; do
  sudo test -z "$(sudo find "$scratch" -xdev -mindepth 1 -uid "$GUEST_UID" -print -quit)"
done
sudo test -z "$(sudo find /dev/mqueue -xdev -mindepth 1 -uid "$GUEST_UID" -print -quit)"
for ipc_flag in q m s; do
  sudo ipcs "-$ipc_flag" -c | awk -v uid="$GUEST_UID" '
    $1 ~ /^[0-9]+$/ && ($3 == "guest" || $5 == "guest" || $3 == uid || $5 == uid) { unsafe=1 }
    END { exit unsafe }
  '
done
sudo test ! -e /var/mail/guest
sudo test ! -e /var/spool/mail/guest
sudo bash -c '
  key=$(keyctl get_persistent @s "$1")
  test "$(keyctl list "$key")" = "keyring is empty"
  keyctl unlink "$key" @s
' _ "$GUEST_UID"
LIVE_SSH_PIN=$(sudo bash -c '
  source /usr/local/lib/labgate/labgate-common.sh
  labgate_compute_ssh_host_key_sha256
')
test "$LIVE_SSH_PIN" = "$(sudo cat /etc/labgate/ssh-host-key-sha256)"
unset LIVE_SSH_PIN
sudo stat -c '%U:%G %a %n' \
  /etc/labgate /etc/labgate/webhook-token \
  /etc/labgate/webhook-curl.conf \
  /etc/labgate/auth-failure-backends \
  /etc/labgate/ssh-host-key-sha256 /var/lib/labgate \
  /var/lib/labgate/outbox /var/lib/labgate/tombstones \
  /usr/local/sbin/labgate-deny-guest-account-change.sh
```

Dormant-safe means:

- guest status is locked;
- provisioner password status is locked, its physical PAM paths deny the account,
  and its effective SSH policy remains public-key forced-command only;
- no real-UID or effective-UID guest processes or logind sessions exist;
- resolved sudo policy grants guest no command, the exact guest-only Polkit rule
  is installed, and the persistent guest linger marker is absent;
- `/home/guest` is not mounted and the dormant directory is root-owned mode 700;
- the guest runtime directory, scratch entries, owned POSIX mqueues,
  created/owned System V IPC, persistent keyring contents, and exact mailbox
  paths are absent;
- the live Ed25519 SSH host-key fingerprint exactly matches the root-only
  registered pin marker;
- current persistent state is absent or revoked/version 3;
- terminal-generation tombstones are root-controlled and valid;
- no unexplained recovery marker exists;
- any outbox backlog is understood and eventually reconciles; and
- Pi `safety_hold_credential_id` is null. A locally dormant endpoint is not
  assignable while an unresolved server hold remains.

Also prove from another host:

- administrator SSH still works;
- guest SSH is rejected even while a pending physical password is valid;
- an arbitrary provisioner command is rejected; and
- the exact generation-scoped issue/revoke shapes are the only accepted
  provisioner commands. Issue carries no password in its command or sudo argv and
  succeeds only with exactly one newline-terminated password on SSH stdin.

## Rollback

### Application rollback

Do not switch tracked files directly on the Pi. On the development machine:

1. Identify the last known-good commit and review schema compatibility.
2. Create a normal revert commit, run tests/build, and push it.
3. On the Pi, stop the app, back up the current failed database, and
   `git pull --ff-only` the revert.
4. Rebuild and start Compose, then verify migrations and health.

Prisma migrations are forward-only. If the reverted application cannot safely
read the migrated schema, restore the pre-deploy SQLite backup while the app is
stopped:

```sh
docker compose stop labgate
failed="data/labgate.failed-$(date +%Y%m%d-%H%M%S).db"
mv data/labgate.db "$failed"
for suffix in -wal -shm -journal; do
  if test -e "data/labgate.db${suffix}"; then
    mv "data/labgate.db${suffix}" "${failed}${suffix}"
  fi
done
cp --preserve=mode "$backup" data/labgate.db
docker compose up -d
```

Restoring loses writes made after the backup and may restore older machine
tokens. Reconcile every enrolled machine before reopening checkout.
If the interval included a successful rekey, keep the endpoint fail-safe secured
and reconcile the restored identity/token/host-pin triple with the root-only endpoint files using
the interrupted-rekey procedure; never let old and new sides send competing
heartbeats.

### Machine rollback

Treat machine rollback as a security change:

1. Drain or fail-safe secure the endpoint.
2. Revert the machine-side change in the development checkout, validate, commit,
   and push it.
3. Pull on the Pi, copy the complete reverted `machine-setup/` directory, and
   rerun the installer in maintenance.
4. Do not roll back to a protocol that lacks generation IDs, monotonic versions,
   persistent outbox, guest SSH denial, or boot lock.
5. Complete the full physical E2E matrix before student use.

## Incident minimum checklist

For a machine that may not be secure:

1. Stop assigning it to students; keep server status occupied/offline.
2. Preserve Pi logs, machine journals, state, recovery marker, and outbox metadata.
3. Run fail-safe boot-lock recovery if a session cannot end normally.
4. Prove dormant-safe local state.
5. Reconcile the exact credential generation, version, and any
   `safety_hold_credential_id` with the Pi. An unrelated terminal event does not
   clear a held physical ID.
6. Correct configuration or deploy a committed fix.
7. Run [E2E-TESTING.md](E2E-TESTING.md) before returning the endpoint.
