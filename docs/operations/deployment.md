# Deploy updates

[Operations index](README.md) · [Documentation hub](../README.md) · [Back to README](../../README.md)

Validate, commit, and push tracked changes from the development machine. On the
Pi, pull only with fast-forward. Back up SQLite before migrations.

```sh
sh deploy/save-database.sh
git pull --ff-only
docker compose up --build -d
docker compose ps
docker compose logs --tail=200 labgate
```

The save command stops the current service and creates a verified, mode-`0600`
SQLite backup in `backups/`. Run it before `git pull` or any migration; the
service remains stopped until the subsequent Compose command starts it again.

Before production rollout, review the migration and rollback requirements in
[AGENTS.md](../../AGENTS.md) and keep a SQLite backup.
