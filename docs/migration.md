# Explicit migration and rollback

Migration is a separate maintenance operation, not part of installation or startup. Keep a verified backup and the old release available. Do not point a development instance at production data.

1. Stop checkout and the JavaScript service. Stop the Go service if installed. Never run both writers against the same database.
2. Make an institution-approved SQLite backup, including a consistent snapshot of any WAL contents. Do not copy only the live `.db` file.
3. Configure the Go server with the same Google origin/client, domain/admin list, provisioning key, registration secret, password length, and login grace. Preserve machine webhook tokens and SSH pins in the database.
4. Inspect the planned operation with `labgate-migrate --database /ABSOLUTE/PATH/labgate.db --dry-run`. This reads only; it creates neither a database nor a lock file.
5. Run `labgate-migrate --database /ABSOLUTE/PATH/labgate.db` explicitly as the owner of the database directory. For the managed server this is `sudo -u labgate-server labgate-migrate`.
6. Run `labgate check`, then start the Go service and verify `/api/health`, Google login, inventory, reservations, and machine reports.

The tool backs up existing databases with SQLite `VACUUM INTO` before changing them. It extends legacy domain tables, normalizes supported datetime representations to Unix milliseconds, preserves legacy Prisma metadata and user/account history, adds Go authentication tables, and invalidates old Better Auth sessions. Domain data is never reset. Already-current databases are validated without rewriting or logging users out again.

All upgrades are transactional and must pass identity, uniqueness, foreign-key, index, integrity, and safety-state validation before commit. Duplicate reservations, available machines with holds/current credentials, malformed identities, or corrupt timestamps abort the operation. Do not “fix” this by deleting reservations or clearing holds.

The Go service holds a shared filesystem lock throughout its lifetime; migration requires an exclusive lock. This protects against concurrent Go writers. The former JavaScript application does not honor that lock, so stopping it is a mandatory operator step.

To roll back after conversion, stop the Go service, preserve its logs and database for investigation, and restore the verified pre-conversion SQLite backup with the matching JavaScript release. Millisecond normalization and Go session tables are not treated as a reversible in-place downgrade. Machines keep enforcing local locks and deadlines during service downtime; reconcile their queued reports and safety state after rollback.
