# Recover and accept LabGate

[Docs home](README.md) · [Pi install](install-pi.md) · [Lab machine install](install-lab-machine.md)

Use this guide when a health check, heartbeat, lifecycle event, timer, or
physical acceptance check fails. The [project contract](../AGENTS.md) is
authoritative. Stop checkout and preserve evidence before making a recovery
change.

## Release rule

Never release a machine solely because a deadline expired, a heartbeat stopped,
or the host became unreachable. The server requires the exact physical
generation to be locked, version 3, and free of an active session. Uncertain
state stays <code>occupied</code> with its persistent safety hold.

<code>CREDENTIAL_TTL_HOURS</code> is only the pending physical-login deadline. A credential
that reached <code>active</code> before that deadline remains active until PAM closes the
session or fail-safe recovery proves it is gone.

There is no maximum duration for an active session unless you specify one.

| Machine state | Version | Local meaning |
| --- | ---: | --- |
| <code>pending</code> | 1 | Password issued; login deadline still applies. |
| <code>active</code> | 2 | PAM opened the configured mode-0700 guest home boundary; deadline is ignored. |
| <code>revoked</code> | 3 | Guest is locked, processes and bounded state are cleared, and home is unmounted. |

## Monitor the Pi

Run on the Pi:

~~~sh
# Pi
cd ~/LabGate
docker compose ps
curl --fail --silent http://127.0.0.1:3000/api/health
docker compose logs --tail=200 labgate
sqlite3 data/labgate.db 'PRAGMA integrity_check;'
~~~

The <code>/api/health</code> route must return HTTP 200 with the compatible enrollment
protocol. A failed container, invalid configuration, migration preflight error,
database postflight error, or failed integrity check is an operator incident;
see [deployment](deployment.md).

Do not expose bearer values while collecting evidence. Redact student email,
webhook tokens, OAuth secrets, private keys, and passwords from tickets and
screenshots.

## Inspect a physical endpoint

Run on the physical lab machine as an administrator:

~~~sh
# Physical lab machine
sudo systemctl status guest-boot-lock.service --no-pager
sudo systemctl list-timers 'guest-*' --all
sudo systemctl status guest-webhook-flush.path guest-webhook-flush.timer --no-pager
sudo journalctl -u guest-boot-lock.service -u guest-cleanup.service \
  -u guest-heartbeat.service -u guest-webhook-flush.service --since '-2 hours' --no-pager
sudo passwd -S guest
sudo loginctl list-sessions
sudo mountpoint /home/guest
sudo ls -la /var/lib/labgate
sudo find /var/lib/labgate/outbox -maxdepth 1 -type f -printf '%f\n' | sort
~~~

The root-controlled state file contains the credential ID, deadline, state, and
version, never a password:

~~~sh
# Physical lab machine
sudo cat /var/lib/labgate/credential-state
sudo test ! -e /var/lib/labgate/recovery-needed
~~~

Do not delete <code>outbox-sequence</code>, tombstones, outbox files, the recovery marker,
or the machine's webhook configuration as a shortcut. The persistent sequence may
contain valid gaps after an interrupted publication.

## Secure a machine

Use an administrator SSH session and physical-console access. If the app must be
taken out of service, stop checkout on the Pi first:

~~~sh
# Pi
cd ~/LabGate
docker compose stop labgate
~~~

Then run the local boot-lock transaction on the affected machine:

~~~sh
# Physical lab machine
sudo /usr/local/sbin/guest-boot-lock.sh
sudo passwd -S guest
sudo loginctl list-sessions
sudo mountpoint /home/guest
~~~

Boot-lock and cleanup lock <code>guest</code>, disable guest linger, terminate guest-owned
processes, clear the bounded runtime, IPC, keyring, mailbox, and scratch paths,
unmount <code>/home/guest</code>, and record local recovery if any step is uncertain.
Persistent-home mode deliberately leaves ordinary files under <code>/home/guest</code>
intact; tmpfs mode has no disk-backed session contents to preserve.
PAM hooks perform these local actions before placing events in the persistent
outbox; they never call the network.

Start the heartbeat only after the local safety transaction is complete:

~~~sh
# Physical lab machine
sudo systemctl start guest-heartbeat.service
sudo systemctl status guest-heartbeat.service --no-pager
~~~

A safe no-state heartbeat can clear a server hold only when the full local
transaction succeeded. An unreachable endpoint, stale heartbeat, or ambiguous
state cannot clear it.

## Outbox and PAM recovery

The selected display-manager PAM file intentionally contains two LabGate session
entries: the `open_session` hook is first, before the normal session stack, and
the `close_session` hook is last, after `pam_systemd`. This lets login prepare a
fresh guest boundary before the desktop starts while logout lets logind release
the session and `/run/user/<guest UID>` before LabGate performs its synchronous
lock, process, IPC, and unmount cleanup. Do not collapse these into one hook line
or move the close hook to the front of the file; that can leave SDDM at a blank
VT after logout.

The webhook flush worker sends versioned events in persistent sequence order.
The path unit watches the outbox directory and starts that worker as soon as PAM
durably publishes an event. The 10-second timer stays enabled as the independent
retry backstop; neither trigger runs curl inside PAM or delays local logout.
Inspect both triggers and the worker journal before touching files:

~~~sh
# Physical lab machine
sudo systemctl is-enabled guest-webhook-flush.timer
sudo systemctl is-active guest-webhook-flush.timer
sudo systemctl is-enabled guest-webhook-flush.path
sudo systemctl is-active guest-webhook-flush.path
sudo journalctl -u guest-webhook-flush.service --since '-2 hours' --no-pager
sudo find /var/lib/labgate/outbox -maxdepth 1 -type f -printf '%f\n' | sort
~~~

A network outage should leave local lock and cleanup successful while events
remain queued. Restore Tailscale/API reachability, then let the 10-second timer
retry. Do not manually reorder files, reset the sequence, start curl from a PAM
hook, or put a token in a process argument.

If setup reports the legacy clock-named outbox, keep the endpoint drained and
prove it is locked, session-free, process-free, and unmounted. Then run the
reviewed migration once from the repository:

~~~sh
# Physical lab machine
sudo env LABGATE_MIGRATE_LEGACY_OUTBOX=1 bash machine-setup/setup-machine.sh
~~~

The migration journals affected IDs, queues authoritative version-3 events, and
archives the old files. If it fails, preserve the archive and marker and stop;
do not retry with deleted state.

## Common incidents

| Symptom | Safe response |
| --- | --- |
| Pi health is not 200 | Inspect Compose logs, configuration, migration preflight, and postflight; do not release machines. |
| Machine is offline or heartbeat is stale | Check Tailscale, time, timers, and administrator SSH. Keep it occupied until safe evidence arrives. |
| Machine is occupied with no current DB credential | Treat it as quarantined. Reconcile physical state and the safety hold; never mark it available manually. |
| Outbox grows during an outage | Confirm local safety still completes, restore API reachability, and allow ordered timer retries. |
| Provisioning failed | The server retries an exact-generation revoke. A failed lock keeps the row unrevoked, immediately expired, held, and occupied. |
| Display-manager or PAM setup fails | Keep the endpoint out of service. Review the supported GDM, LightDM, or SDDM password stack and its include graph. |
| A host-key pin changed | Stop provisioning and use the drained authenticated rekey workflow; do not overwrite the marker or POST a new identity. |
| Arch installer starts a full upgrade or downloads a very large system update | Stop that older installer with `Ctrl-C`; it is not the current behavior. The current installer checks the fixed prerequisite list and installs only missing packages with `pacman -S --needed`. Do not run `pacman -Sy` alone. Preserve the package-manager error; if the sync database is stale, use a separately approved system-maintenance window or install the missing prerequisites manually, then rerun the installer. |
| Arch prerequisite installation fails | Keep the endpoint out of service and retain the complete pacman output. The installer does not perform a full system upgrade. Verify the missing package names with `pacman -Q`, resolve the package-manager issue under normal OS maintenance policy, and rerun the reviewed installer. |
| Setup says the Polkit rules directory is not root-owned | Check `sudo stat -c '%A %U:%G %n' /etc/polkit-1/rules.d`. Arch-family systems may use `root:polkitd` with a non-writable mode such as `0750`; that is accepted. A non-root owner or group/other write permission remains a hard failure. |

## Physical acceptance

Run on a non-production physical machine with the dashboard visible. Record
timestamps, redacted IDs, commands, and pass/fail evidence in
[PROGRESS.md](../PROGRESS.md). Do not mark acceptance complete from local tests
alone.

For the near-real-time logout check, keep the student machine page, admin
machine page, and newest admin activity page visible. Historical activity pages
do not auto-refresh. Reserve and physically log in, then record a UTC timestamp
as the desktop logout starts. After the display manager returns, confirm locally
that `guest` is locked, its session/processes are gone, and `/home/guest` is
unmounted. Record when both machine pages show `available` and the newest
activity page shows the attributable physical **Logged out** row. With healthy
Pi/workstation connectivity, both remote observations must arrive within the
next completed two-second visible-page refresh cycle.

Repeat once with the Pi application intentionally stopped after the physical
login and before logout:

~~~sh
# Pi; declared acceptance maintenance window
cd ~/LabGate
docker compose stop labgate

# After local logout evidence and queued outbox evidence are recorded
docker compose up -d labgate
curl --fail --silent http://127.0.0.1:3000/api/health
~~~

Logout must still complete its local security transaction while the API is
stopped, and the ordered event must remain in the outbox. After the Pi returns,
leave both machine triggers enabled and confirm the timer drains the event,
releases the exact safe generation, and adds the physical logout row. Record
redacted timestamps and outbox filenames, but never a token or password.

Prove all of the following:

- Checkout displays one password once, with exactly <code>GUEST_PASSWORD_LENGTH</code>
  allowed characters; the web app and machine state contain no password.
- A checkout is <code>pending</code> / version 1, a successful physical PAM login is
  <code>active</code> / version 2, and logout or unused expiry becomes <code>revoked</code> /
  version 3.
- A login just before the pending deadline remains active after the deadline.
  An unused pending password fails after the deadline.
- Logout and the next login receive a fresh tmpfs home in <code>n</code> mode, or
  preserve ordinary home files in <code>y</code> mode, and both receive a clean
  mode-0700 runtime directory.
- A webhook outage leaves ordered outbox events while local lock, process
  cleanup, and unmount still complete.
- A power cycle runs boot lock before display-manager and SSH login paths.
- SSH as <code>guest</code> is denied; arbitrary provisioner commands,
  forwarding, TTY, and shell access are denied; administrator SSH remains usable.
- Fresh enrollment begins with provisioner <code>nologin</code> and publishes the key
  last. Supported display-manager PAM paths work, unknown paths and
  <code>pam_fprintd.so</code> are rejected, and guest <code>passwd</code>, <code>chsh</code>, and
  <code>chfn</code> changes are denied for non-root users.
- A drained identity rekey rotates the token, holds the endpoint offline, rejects
  the old token, and releases only after a safe locked heartbeat. Host-key pin
  verification and legacy-null CAS behave as documented.
- Guest password aging is non-expiring, PAM failure counters reset before unlock,
  and bounded runtime, IPC, keyring, mailbox, and scratch cleanup completes.
- Unexpected physical generations create persistent safety holds; unrelated
  close events do not release them; only exact-held-ID version 3 or a genuinely
  safe no-state heartbeat clears the hold.
- Concurrent checkout leaves one winner and a conflict response for the other;
  stale lifecycle events cannot mutate the newer generation.

After every item passes, verify the dashboard shows the machine available and
record the evidence before reopening student use. Continue to
[deployment](deployment.md) for the next release or
[decommissioning](uninstall.md) when retiring the service.
