# Deploy a reviewed release

[Docs home](README.md) · [Pi install](install-pi.md) · [Lab machine install](install-lab-machine.md)

Keep tracked-file changes local-first: validate on the development machine,
commit, push, and then fast-forward the Pi. Runtime configuration and root-owned
secret files may be maintained on the Pi, but do not edit tracked project files
there.

## Development machine: validate and publish

Before publishing an image that requires administrator authorization, prepare a
valid <code>ADMIN_EMAILS</code> line for the Pi's ignored <code>.env.local</code>. Every address must
be an exact account under <code>ALLOWED_EMAIL_DOMAIN</code>. Startup intentionally fails if
the administrator list is missing or invalid, so configure it on the Pi before
replacing the running container.

Run from the repository checkout. Stage only the intended files; preserve
unrelated worktree changes.

~~~sh
# Development machine
git diff --check
npm test
npm run lint
npm run typecheck
npm run build
git status --short
git add <INTENDED_FILES>
git commit -m "<RELEASE_MESSAGE>"
git push origin main
git rev-parse HEAD
~~~

Record the resulting <code>&lt;COMMIT_SHA&gt;</code>. Do not proceed if the checks fail or the
commit is not the one reviewed for the machine policy.

## Pi: back up and deploy

Run from <code>~/LabGate</code> on the Pi. Stop the application before a backup or pull so
SQLite and its bind-mounted data are quiescent.

~~~sh
# Pi
cd ~/LabGate
git fetch origin main
git log -1 --oneline
sudoedit .env.local
docker compose stop labgate
sqlite3 data/labgate.db ".backup 'backups/labgate-$(date -u +%Y%m%dT%H%M%SZ).db'"
git pull --ff-only origin main
git diff HEAD@{1}..HEAD -- prisma/migrations
docker compose up --build -d
~~~

Before saving <code>.env.local</code>, add or replace the complete
<code>ADMIN_EMAILS=...</code> line prepared during review. Do not put it in a
<code>NEXT_PUBLIC_</code> variable. The admin dashboard can generate the replacement line,
but it never edits the Pi environment itself.

The container entrypoint performs startup configuration validation, migration
preflight, <code>prisma migrate deploy</code>, and database postflight before starting
the server. Review the migration diff before the rollout; a preflight failure must
leave the service stopped for reconciliation.

## Health checks

~~~sh
# Pi
docker compose ps
docker compose logs --tail=200 labgate
curl --fail --silent http://127.0.0.1:3000/api/health
sqlite3 data/labgate.db 'PRAGMA integrity_check;'
~~~

Check the public HTTPS origin separately through the approved reverse proxy. Do
not treat a healthy app as physical acceptance; a lab machine still needs a
safe heartbeat and the [physical checklist](recovery.md#physical-acceptance).

## Rollback

Rollback is a reviewed release operation. First stop checkout, preserve the
failed container logs and the backup path, and prepare a known-good commit on
the development machine. Push that rollback commit, then deploy it to the Pi
with <code>git pull --ff-only</code> and the same health checks.

If a migration changed the database and the known-good code is not compatible,
stop the service and restore the institution-approved SQLite backup only after
confirming the backup and its corresponding code revision:

~~~sh
# Pi; replace the placeholder with a verified backup path
cd ~/LabGate
docker compose stop labgate
cp backups/<VERIFIED_BACKUP>.db data/labgate.db
chmod 600 data/labgate.db
docker compose up -d
~~~

Never use <code>docker compose down --volumes</code>, delete the database to clear a
reservation, or release a machine because the app is unavailable. Continue with
[recovery](recovery.md) whenever the deployed and physical generations cannot
be reconciled.
