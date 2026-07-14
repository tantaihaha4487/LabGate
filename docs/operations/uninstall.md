# Uninstall or decommission

[Operations index](README.md) · [Documentation hub](../README.md) · [Back to README](../../README.md)

There is no safe one-command uninstall. Decommissioning is a security change.
The committed scripts split the operation into a Pi stop, one local operation
per physical endpoint, and a final Pi cleanup.

Run this only in a declared maintenance window with an administrator SSH
session and physical-console recovery available:

```sh
cd ~/LabGate
./deploy/uninstall-pi.sh prepare --confirm
```

After the Pi has stopped accepting checkout traffic, run the local script on
each drained physical endpoint as root:

```sh
sudo bash /tmp/labgate-machine-setup/uninstall-machine.sh --confirm
```

Use the reviewed `machine-setup/` directory from the checked-out commit. The
script runs boot-lock recovery, verifies that `guest` is locked and has no
session, process, mount, or pending recovery marker, backs up the affected PAM
files under `/root/labgate-uninstall-<timestamp>`, disables the lifecycle
timers, removes only the display-manager LabGate session hook, retains the
`guest` `passwd`/`chfn`/`chsh` account-change guards, and verifies the result.

After every endpoint succeeds, remove the stopped Pi application:

```sh
cd ~/LabGate
./deploy/uninstall-pi.sh finalize --confirm
```

The scripts are intentionally staged. Do not run `finalize` until every
physical endpoint has been secured and its script has completed successfully.
The Pi script preserves the repository, database, secrets, and bind-mounted
data; it never uses `docker compose down --volumes`.

The machine script retains the shared `guest` and `provisioner` accounts,
guest SSH denial, provisioner forced-command restrictions, boot lock, local
state, and identity files. Do not delete `/etc/labgate` or the machine database
row as a shortcut. Keep the endpoint secured until its exact credential state
is reconciled and the institution deliberately retires the shared identity
through a separately reviewed process.

If `prepare` or a machine uninstall fails, leave the Pi stopped, preserve the
PAM backup and local state, and use the administrator session or physical
recovery console before retrying. A dry run is available with
`--dry-run`; it performs no host mutation.
