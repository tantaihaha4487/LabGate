# Decommission the full deployment

[Docs home](README.md) · [Pi install](install-pi.md) · [Lab machine install](install-lab-machine.md)

There is no safe one-command uninstall. Decommissioning is a security change:
stop the Pi application, secure every physical endpoint, then remove only the
stopped Pi application. Run this in a declared maintenance window with an
administrator SSH session and physical-console recovery available.

Read [AGENTS.md](../AGENTS.md) first. The shared <code>guest</code> and constrained
<code>provisioner</code> identities are retained; this procedure does not delete operating
system accounts or erase lifecycle state.

## 1. Stop the Pi application

Run on the Pi from the reviewed checkout:

~~~sh
# Pi
cd ~/LabGate
./deploy/uninstall-pi.sh prepare --confirm
~~~

<code>prepare</code> stops the Compose service and refuses to change the Pi without
<code>--confirm</code>. A dry run is available:

~~~sh
# Pi
./deploy/uninstall-pi.sh prepare --dry-run
~~~

## 2. Secure every physical endpoint

Use the reviewed <code>machine-setup/uninstall-machine.sh</code> from the same
commit. Run on each drained physical machine:

~~~sh
# Physical lab machine
sudo bash machine-setup/uninstall-machine.sh --dry-run
sudo bash machine-setup/uninstall-machine.sh --confirm
~~~

The machine script runs boot-lock recovery and proves <code>guest</code> is locked,
session-free, process-free, unmounted, and not waiting on local recovery. It
backs up affected PAM files under
<code>/root/labgate-uninstall-&lt;timestamp&gt;</code>, disables lifecycle path/timer triggers, removes
only the display-manager LabGate session hook, retains the account-change guards,
and verifies the result.

Do not run the final Pi step until every endpoint succeeds. If one fails, leave
the Pi stopped, preserve local state and the PAM backup, and recover through the
administrator session or physical console.

## 3. Remove the stopped Pi application

After all endpoints are secured:

~~~sh
# Pi
cd ~/LabGate
./deploy/uninstall-pi.sh finalize --confirm
~~~

<code>finalize</code> runs <code>docker compose down</code> without deleting bind-mounted data,
secrets, backups, or the repository. It never uses the <code>--volumes</code> option.

Retain the database, backups, audit evidence, and machine state according to the
institution's retention policy. Do not delete <code>/etc/labgate</code>, the machine
database row, tombstones, or the shared identities as an administrative shortcut.
Reconcile the exact credential generation before any separately reviewed identity
retirement.

## Failure handling

If <code>prepare</code>, an endpoint uninstall, or <code>finalize</code> fails, do not proceed to
the next stage. Preserve logs and state, keep the Pi stopped, and use
[recovery](recovery.md) before retrying.
