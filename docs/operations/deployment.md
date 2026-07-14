# Deploy updates

[Operations index](README.md) · [Documentation hub](../README.md) · [Back to README](../../README.md)

Validate, commit, and push tracked changes from the development machine. On the
Pi, pull only with fast-forward. Back up SQLite before migrations.

```sh
git pull --ff-only
docker compose up --build -d
docker compose ps
docker compose logs --tail=200 labgate
```

Before production rollout, review the migration and rollback requirements in
[AGENTS.md](../../AGENTS.md) and keep a SQLite backup.
