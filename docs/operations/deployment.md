# Deploy updates

[Operations index](README.md) · [Full reference](../OPERATIONS.md) · [Back to README](../../README.md)

Validate, commit, and push tracked changes from the development machine. On the
Pi, pull only with fast-forward. Back up SQLite before migrations.

```sh
git pull --ff-only
docker compose up --build -d
docker compose ps
docker compose logs --tail=200 labgate
```

Use the [full deployment procedure](../OPERATIONS.md#commit-push-pi-pull-and-deploy)
for preflight, backup, migration, and rollback gates.
