# LabGate physical end-to-end testing

This is the release-gate test plan for one non-production physical Ubuntu
Desktop endpoint and the Raspberry Pi deployment. Unit and integration tests are
necessary but cannot prove display-manager PAM behavior, tmpfs isolation, boot
ordering, or physical credential rejection.

Do not run disruptive cases on a machine assigned to a student. Never capture a
guest password, bearer token, OAuth token, private key, or full `.env.local` in
test evidence.

## Lifecycle acceptance rule

`CREDENTIAL_TTL_HOURS` is only the deadline for beginning the physical login.

There is no maximum duration for an active session unless you specify one.

Expected monotonic machine state is:

```text
checkout -> pending / 1 -> physical PAM open -> active / 2
                                      |
                                      +-> physical PAM close -> revoked / 3

checkout -> pending / 1 -> no login by deadline -> revoked / 3
```

The server must keep the reservation non-available until the exact generation is
confirmed revoked and locally safe. An unreachable machine, expired timestamp,
or stale heartbeat is not sufficient proof.

## Roles and equipment

Use two people for power-loss, PAM, SSH-policy, and recovery cases when possible:

- **operator** — has Pi and lab-machine administrator access;
- **student tester** — uses an allowed Google account and the physical login
  screen; and
- **observer** — records redacted timestamps and prevents accidental reuse of a
  production endpoint.

Required:

- the committed candidate deployed to `~/LabGate` on the Pi;
- one isolated Ubuntu Desktop lab machine enrolled with the matching protocol;
- physical keyboard and display;
- administrator access through a separate session or console;
- valid allowed-domain and disallowed-domain Google test identities;
- ability to interrupt the lab machine's Tailscale link and power; and
- synchronized clocks on Pi and lab machine.

## Evidence worksheet

Create a restricted operator record outside the public repository:

| Field | Value |
|---|---|
| Candidate commit | |
| Pi hostname | |
| Lab machine name / Tailscale IP | |
| Ubuntu version / kernel | |
| Display manager and PAM file | |
| App password length | |
| Machine password length | |
| Pending TTL | |
| Test start/end in Asia/Bangkok | |
| Operator / observer | |

For every case record:

- case ID and pass/fail;
- wall-clock timestamps from Pi and machine;
- credential ID reduced to a safe correlation form such as first six and last
  four characters;
- machine state/version, session-active, lock status, mount status, and UI state;
- relevant redacted log lines; and
- issue reference for any failure.

Do not record the one-time password. Recording its length and whether it was
accepted/rejected is sufficient.

## Preflight

### 1. Validate the candidate on the development machine

```sh
npm test
npm run lint
npm run build
git diff --check
git status --short
git rev-parse HEAD
```

All intended changes must be committed and pushed. Deploy with the
commit-push-Pi-pull procedure in [OPERATIONS.md](OPERATIONS.md).

### 2. Verify Pi health and configuration

```sh
ssh 'labgate-1@raspberrypi.tailfdedcf.ts.net'
cd ~/LabGate
git rev-parse HEAD
docker compose ps
docker compose logs --tail=100 labgate
docker compose exec -T labgate npx prisma migrate status
```

Record, but do not publish, the non-secret configured TTL and password length.
Confirm the root cron sweep uses `/etc/labgate/cron-curl.conf` and does not embed
the bearer in crontab text. Retain hashes—not values—showing that existing
URL-safe registration/cron secrets were not rotated for the RFC 6750 compatibility
expansion, and verify the automated preflight accepts standard Base64 `+`, `/`,
and trailing `=` within the 20–256-character boundary.

### 3. Verify endpoint installation

On the lab machine:

```sh
sudo visudo -cf /etc/sudoers.d/labgate-guest-provision
sudo sshd -t
sudo cat /etc/labgate/password-length
sudo cat /etc/labgate/pam-file
sudo cat /etc/labgate/auth-failure-backends
sudo cat /etc/labgate/ssh-host-key-sha256
sudo systemctl is-enabled \
  guest-boot-lock.service guest-cleanup.timer \
  guest-heartbeat.timer guest-webhook-flush.timer
sudo systemctl is-active \
  guest-boot-lock.service guest-cleanup.timer \
  guest-heartbeat.timer guest-webhook-flush.timer
sudo test -s /etc/labgate/webhook-token
sudo test -s /etc/labgate/webhook-curl.conf
sudo test ! -e /var/lib/labgate/recovery-needed
test "$(getent passwd provisioner | awk -F: '{ print $7 }')" = /bin/sh
sudo passwd --status provisioner | awk '$2 == "L" || $2 == "LK" { ok=1 } END { exit !ok }'
PROVISIONER_HOME=$(getent passwd provisioner | awk -F: '{ print $6 }')
test "$(sudo stat -c %U:%G "$PROVISIONER_HOME")" = root:root
test "$(sudo stat -c %a "$PROVISIONER_HOME")" = 755
test "$(sudo stat -c %U:%G "$PROVISIONER_HOME/.ssh")" = provisioner:provisioner
test "$(sudo stat -c %a "$PROVISIONER_HOME/.ssh")" = 700
test "$(sudo stat -c %U:%G "$PROVISIONER_HOME/.ssh/authorized_keys")" = provisioner:provisioner
test "$(sudo stat -c %a "$PROVISIONER_HOME/.ssh/authorized_keys")" = 600
sudo grep -Fnx -- \
  'auth requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh' \
  /etc/pam.d/chfn /etc/pam.d/chsh
sudo grep -Fnx -- \
  'password requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh' \
  /etc/pam.d/passwd
sudo grep -Fnx -- \
  'account requisite pam_succeed_if.so quiet user != provisioner' \
  "$(sudo cat /etc/labgate/pam-file)" \
  /etc/pam.d/login /etc/pam.d/su /etc/pam.d/su-l
sudo env LC_ALL=C sudo -n -l -U guest
sudo cmp -s /tmp/labgate-machine-setup/00-labgate-deny-guest.rules \
  /etc/polkit-1/rules.d/00-labgate-deny-guest.rules
test "$(sudo stat -c %U:%G /etc/polkit-1/rules.d/00-labgate-deny-guest.rules)" = root:root
test "$(sudo stat -c %a /etc/polkit-1/rules.d/00-labgate-deny-guest.rules)" = 644
sudo test ! -e /var/lib/systemd/linger/guest
sudo test ! -L /var/lib/systemd/linger/guest
LIVE_SSH_PIN=$(sudo bash -c '
  source /usr/local/lib/labgate/labgate-common.sh
  labgate_compute_ssh_host_key_sha256
')
test "$LIVE_SSH_PIN" = "$(sudo cat /etc/labgate/ssh-host-key-sha256)"
unset LIVE_SSH_PIN
timedatectl status
```

The app and machine password lengths must be identical. Clock synchronization
must be active because pending deadlines use Unix wall time. Run the complete PAM
path inventory in [OPERATIONS.md](OPERATIONS.md#inspect): known alternate
display-manager paths must deny `guest`, no unknown matching path may exist, and
the selected auth include graph must have passed the installer's
`pam_fprintd.so` rejection. Retain initial-enrollment evidence that `provisioner`
used verified `nologin` with no key before setup and that `authorized_keys` was
installed only after the forced-command policy passed.

### 4. Establish dormant-safe baseline

With no student session or reservation:

```sh
sudo passwd --status guest
sudo loginctl list-sessions --no-legend
sudo findmnt --target /home/guest
sudo pgrep -a -u "$(id -u guest)"
sudo pgrep -a -U "$(id -u guest)"
sudo test ! -e /var/lib/systemd/linger/guest
sudo find /var/lib/labgate/outbox -maxdepth 1 -type f -name 'event-*' -print
```

Pass only if the guest account is locked, no guest process/session exists,
`/home/guest` is not mounted, the dormant directory is root-owned mode 700, and
there is no unexplained outbox or recovery marker.

## Acceptance matrix

| ID | Scenario | Required result |
|---|---|---|
| E01 | Allowed and disallowed Google authentication | Allowed account enters dashboard; disallowed account never establishes a server session |
| E02 | Exact password length and deadline bounds | `8` produces exactly eight allowed characters; another supported value is exact; malformed values and machine deadlines beyond 24h + 60s fail |
| E03 | Concurrent checkout | One request succeeds and one returns `409`; one unrevoked generation exists |
| E04 | Pending generation | Checkout produces pending/version 1, unlocked physical password, occupied UI |
| E05 | Login before deadline, remain past deadline | PAM open produces active/version 2; session remains usable and occupied after deadline |
| E06 | Orderly logout | Local lock/process termination/unmount precede revoked/version 3 and server release |
| E07 | Fresh home on next login | Prior-session file is absent and mount is a new tmpfs |
| E08 | No-login expiry | Pending password stops working; local state reaches revoked/version 3; release follows confirmation |
| E09 | No-login expiry while network is down | Local lock still occurs; event persists; server does not release until connectivity and confirmation return |
| E10 | PAM open/close while webhooks are unreachable | Local lifecycle succeeds; version-2 then version-3 events remain ordered and later drain |
| E11 | Second concurrent physical login | Second open is denied and its close cannot terminate the legitimate first session |
| E12 | Active-session power loss and reboot | Boot lock secures before login services; old password fails; server reconciles version 3 |
| E13 | Stale active without logind session | After 120-second grace, cleanup secures and reports revoked/version 3 |
| E14 | Stale/unknown generation and safety holds | Delayed close cannot release; one unsafe generation persists an exact hold; contradictory generations persist the conflict sentinel; exact terminal clears only its exact hold and a fresh globally safe no-state heartbeat clears conflict |
| E15 | SSH and password-stdin boundaries | Administrator SSH works; guest SSH and arbitrary provisioner commands fail; issue password exists only as one stdin line |
| E16 | Provisioning failure compensation | Password is not returned; release occurs only when exact-generation lock is confirmed |
| E17 | Offline display and recovery | Dashboard derives offline after heartbeat window but retains unsafe reservation |
| E18 | Pi restart and cron sweep | Migrations/health recover; active survives deadline; expired pending requires confirmed revoke |
| E19 | Machine bootstrap/installer/PAM/Polkit guards | Nologin-first/key-last bootstrap, locked/physically-denied provisioner, zero guest sudo grants, exact universal guest Polkit denial, bounded runtime/IPC/keyring/mail cleanup, PAM counter/aging guards, and account-change denial pass |
| E20 | Rollback drill | Backup restores in isolation and committed revert reaches Pi without direct tracked-file edits |
| E21 | Startup/registration POST guards | Invalid env/key, available+current, or available+hold fails; occupied quarantine persists; immutable name/address/host-pin POST mismatch returns `409` without mutation |
| E22 | Drained identity/token/host-pin rekey | PATCH rotates atomically, supports only explicit legacy-null pin CAS, holds offline, rejects old token, and releases only after pinned SSH plus a new-token safe heartbeat; recovery/rollback pass |
| E23 | Monotonic outbox and legacy migration | Clock changes cannot reorder events; blocked delivery cannot block producers; known legacy backlog terminalizes and archives only in a drained opt-in migration |

## Detailed procedures

### E01 — Authentication boundaries

1. Open the production HTTPS URL in a clean browser profile.
2. Exercise every visible unauthenticated link and login control.
3. Sign in with the disallowed-domain test identity.
4. Verify the server rejects it and protected pages/APIs remain inaccessible.
5. Clear the browser site data, then sign in with the allowed-domain identity.
6. Verify dashboard load, logout, and re-login.
7. Inspect Pi logs for a server-side domain decision without tokens or secrets.

Pass requires both Google's hosted-domain hint and the independent server suffix
check to be effective.

### E02 — Exact password length and charset

1. Set both app `GUEST_PASSWORD_LENGTH` and machine
   `LABGATE_PASSWORD_LENGTH` to `8`; deploy/reinstall in maintenance.
2. Perform at least ten checkout/expire or checkout/logout cycles.
3. For each one, record only the displayed password length and whether every
   character belongs to the documented unambiguous set.
4. Confirm all ten lengths are exactly eight and none includes an ambiguous or
   shell-special character.
5. Repeat once with a second supported value, such as `12`, on the isolated
   machine only.
6. Run automated configuration tests proving a fractional, below-minimum,
   above-maximum, or non-numeric value fails instead of silently defaulting.
7. In the rootless machine suite, require an issue deadline at local now plus
   86,461 seconds to fail while the normal short future deadline succeeds. This
   proves the independent 24-hour maximum plus exactly 60 seconds of clock-skew
   tolerance; do not test by lengthening a live student reservation.
8. Restore the intended production length on both sides and verify equality.

### E03 — Concurrent checkout

1. Start with one available, recently heartbeating machine and no unrevoked
   credential for either test student.
2. Submit checkout for the same machine nearly simultaneously from two isolated
   authenticated sessions.
3. Record HTTP status/body shape without recording the successful password.
4. Confirm exactly one success, exactly one `409`, one machine generation, and
   machine status occupied.
5. Secure/revoke the successful pending generation before continuing.

Also retain the automated concurrency-test output as repeatable evidence.

### E04 — Pending/version 1

1. Checkout the isolated machine but do not touch the physical login screen.
2. Immediately inspect on the machine:

   ```sh
   sudo cat /var/lib/labgate/credential-state
   sudo passwd --status guest
   sudo test ! -e /run/labgate/pam-session
   sudo findmnt --target /home/guest
   ```

3. Verify the state fields contain the returned credential generation, future
   deadline, `pending`, version `1`, and a changed-at time.
4. Verify the account is temporarily unlocked, no PAM marker exists, no tmpfs is
   mounted, and the dashboard is occupied.
5. Verify persistent state contains no password.

### E05 — Login before deadline and remain active after it

1. Use a short but valid pending TTL, at least one minute.
2. Checkout, then wait until close to—but safely before—the displayed deadline.
3. At the physical keyboard, sign in as `guest` with the one-time password.
4. Immediately verify:

   ```sh
   sudo cat /var/lib/labgate/credential-state
   sudo test -s /run/labgate/pam-session
   sudo findmnt -n -o FSTYPE,OPTIONS --target /home/guest
   ```

5. State must be `active`, version `2`; `/home/guest` must be tmpfs with
   `nosuid,nodev`; the dashboard must be occupied.
6. Create a harmless marker file under `/home/guest`.
7. Remain logged in beyond the original deadline by at least two cleanup cycles
   and one Pi sweep.
8. Continue using the desktop and verify state remains active/version 2,
   no lock occurs, and the dashboard remains occupied.

Any logout, lockout, or availability transition caused solely by the original
deadline fails the release gate.

### E06 — Orderly logout and confirmed release

1. Log out through the physical desktop UI.
2. Within one cleanup/outbox interval, verify:

   ```sh
   sudo cat /var/lib/labgate/credential-state
   sudo passwd --status guest
   sudo test ! -e /run/labgate/pam-session
   sudo findmnt --target /home/guest
   sudo pgrep -a -u "$(id -u guest)"
   sudo pgrep -a -U "$(id -u guest)"
   sudo test ! -e "/run/user/$(id -u guest)"
   sudo test ! -e /var/mail/guest
   sudo test ! -e /var/spool/mail/guest
   ```

3. Require revoked/version 3, locked status, no marker, no mount, and no guest
   process under either real or effective UID. The guest runtime directory and
   exact mailbox paths must also be absent.
4. Verify the server records the exact generation close and only then shows the
   machine available.

### E07 — Fresh tmpfs on the next login

1. Checkout a new generation and physically log in.
2. Confirm the previous marker file is absent before creating any new data.
3. Verify a tmpfs is mounted with the expected ownership and safe options.
4. Verify `/run/user/<guest UID>` is a fresh directory owned by the dedicated
   guest UID/GID at mode `0700`; no prior runtime marker may survive.
5. Confirm the new credential ID differs from the prior generation and state is
   active/version 2.
6. Log out and reconfirm E06.

### E08 — Pending expiry without physical login

1. Checkout with a short valid TTL and do not enter the password.
2. Verify pending/version 1 before the deadline.
3. Wait through the deadline plus cleanup and webhook-flush intervals.
4. Verify local revoked/version 3, locked status, no session/mount/process, and a
   terminal event or reconciled heartbeat.
5. Attempt the old password at the physical login screen; it must fail.
6. Verify the UI hides/expires the credential and the server returns the machine
   to available only after version-3 lock confirmation.
7. Checkout again and prove the old password remains invalid while the new one
   is accepted.

### E09 — Pending expiry during network outage

Use the physical console so stopping Tailscale does not strand the operator.

1. Checkout and verify pending/version 1.
2. Before the deadline, stop Tailscale on the lab machine.
3. Wait past the deadline and at least two cleanup intervals.
4. Locally verify revoked/version 3, locked status, and a retained
   `credential-expired` outbox event.
5. On the Pi, verify the machine becomes offline/non-available and is not released
   merely by the sweep.
6. Restore Tailscale, start webhook flush and heartbeat, and verify the queued
   terminal event drains.
7. Only after exact-generation confirmation may the UI become available.

### E10 — Ordered PAM events while network is unavailable

1. Checkout while connectivity is healthy.
2. Stop Tailscale on the machine, then physically log in before the deadline.
3. Verify local active/version 2 and a queued `session-open` version-2 event.
4. Log out physically while still offline.
5. Verify local revoked/version 3 and a later queued `session-close` version-3
   event. Local lock and unmount must not wait for networking.
6. List outbox filenames in lexical order. Require fixed-width
   `event-v2-<18 digits>` names whose close sequence is greater than open; wall
   clock values must not appear in the ordering key.
7. Restore connectivity; verify the worker removes open only after successful
   delivery, then close, and server state never regresses.

### E11 — Concurrent physical login protection

1. Establish one active physical desktop session.
2. Use the display manager's switch-user flow to attempt a second `guest` login
   with the same password.
3. The second PAM open must fail because the generation is already active.
4. Return to the original desktop and verify it remains usable, mounted, and
   active/version 2.
5. Verify the failed transaction's close did not terminate the legitimate
   session or emit version 3.
6. Log out the original session normally and verify E06.

### E12 — Active-session power loss and boot lock

1. Establish active/version 2 and create a harmless tmpfs marker.
2. Record the original generation correlation and deadline.
3. Hard-power the non-production machine off without logging out.
4. Leave power off beyond the original deadline; verify the Pi does not release
   based solely on time or stale heartbeat.
5. Power on and observe the real boot.
6. Verify `guest-boot-lock.service` completed before display-manager and SSH
   services, local state is revoked/version 3, and the old password fails.
7. Verify the prior tmpfs data is absent and heartbeat/outbox reconciliation
   eventually permits server release.

### E13 — Stale active recovery without logind session

This case deliberately disrupts the display manager. Keep an administrator
console open.

1. Establish active/version 2.
2. Abruptly kill the display-manager service so normal PAM close is bypassed,
   then verify logind no longer reports a guest session.
3. Do not edit the credential-state file.
4. Before 120 seconds from state change, cleanup must avoid racing the PAM-open
   publication grace.
5. After the grace plus cleanup interval, require local secure state and
   revoked/version 3.
6. Restart the display manager, reconcile server state, and run a clean
   checkout/login/logout before passing the endpoint.

If the host's display manager still executes PAM close during the abrupt stop,
record that result and use an isolated VM fault-injection fixture for the stale
active branch; do not weaken PAM to manufacture it on a production endpoint.

### E14 — Delayed old-generation event

Use isolated fixtures plus root-only heartbeat request files; keep the bearer in
`/etc/labgate/webhook-curl.conf`, never argv.

1. Complete generation A through revoked/version 3 and retain only its ID.
2. Checkout generation B and verify pending/version 1.
3. Replay a syntactically valid authenticated version-2 `session-open` event for
   terminal A. It must not reopen A, but transport must return 2xx after recording
   the decision, with JSON `conflict`, `held`, or `not_found` as appropriate.
   Finish B safely before the physical-authority branches.
4. Create a current generation C, then submit a valid heartbeat reporting an
   unknown physical generation X as active/version 2. Require C to be
   terminalized/version 3, machine status occupied, and
   `safety_hold_credential_id = X` even though X has no DB row.
5. Replay a version-3 close for C or any other unrelated/unknown ID. It may update
   audit/heartbeat evidence, but machine status must remain occupied and the hold
   must remain exactly X. Require a 2xx transport acknowledgement with a non-release
   JSON status, not a retry-poisoning 4xx.
6. Submit a locked, session-free revoked/version-3 report for X. Require the hold
   to clear and release only because no current DB credential remains.
7. Repeat steps 4–6 with an unknown pending/version-1 generation Y. The unsafe
   pending snapshot must terminalize any current row and hold exactly Y; an
   unrelated close cannot release; exact locked version 3 for Y can.
8. With a DB-terminal generation Z and an available machine, submit a fresh
   heartbeat claiming Z is physically active/version 2. Require a new occupied
   hold for Z. Its prior DB terminal timestamp is not physical safety proof;
   exact locked version 3 for Z must clear it.
9. Queue an unknown-but-valid open followed by its exact version-3 close through
   the persistent machine outbox. Both requests must receive 2xx and drain in
   order; the first persists a hold and the later exact terminal event advances it.
   Authentication, malformed input, and endpoint/version mismatch remain the only
   4xx classes.
10. Separately exercise the no-ID branch with no current DB row and a truly absent
    local generation. Use the isolated request fixture to establish a hold for an
    unknown W. Before the local heartbeat emits null state, seed an orphan guest
    process, mounted home, PAM marker, and regular linger marker; require it to
    secure and remove all four under the lifecycle lock. A genuinely locked safe
    no-state heartbeat may then clear the hold.
11. Make the linger marker unremovable in a rootless fixture/restorable VM and
    require recovery plus no outbound no-state heartbeat. Repeat with a corrupt
    credential-state file: local safety still runs, but no safe no-state snapshot
    is serialized and the server hold remains. Never delete state to manufacture
    a clearing report.
12. Remove temporary request files and verify no `available` row retains a hold.

### E15 — SSH and password-stdin boundaries

Perform while one physical password is pending, using interactive prompts so the
password is never in a command line:

1. Confirm the normal administrator identity can still SSH to the lab machine.
2. Attempt SSH as `guest`; it must be denied even with the valid pending physical
   password.
3. From the Pi, use the provisioning key to request an arbitrary harmless command;
   the forced dispatcher must deny it with non-zero status.
4. Verify effective SSH configuration is public-key-only with
   `PermitUserEnvironment no`; only `LANG`/`LC_*` may appear in `AcceptEnv`; user
   startup files, forwarding, TTY, agent, X11, and tunnel capabilities are
   disabled for `provisioner`.
5. Verify its account shell is exactly `/bin/sh`, its home is `root:root 0755`,
   `.ssh` is provisioner-owned mode 0700, and the dispatcher invokes only the
   executable root-owned regular `/usr/bin/sudo` path. Its `passwd --status` must
   be `L`/`LK`, and physical display-manager plus `login`/`su` PAM paths must deny
   `provisioner` while key-based forced-command SSH still works.
6. Attempt provisioner password/keyboard-interactive authentication without the
   key; it must fail.
7. Retain automated-test evidence that issue constructs exactly
   `sudo /usr/local/sbin/guest-account.sh issue <id> <expiry>` and supplies the
   password as one newline-terminated SSH stdin line. The password must be absent
   from `SSH_ORIGINAL_COMMAND`, sudo argv, errors, process listings, and journals.
8. Exercise dispatcher/root-script fixtures for missing input, no terminating
   newline, an extra line, malformed characters, and wrong exact length. Every
   case must fail without unlocking `guest` or creating pending state.
9. Confirm the app's exact generation-scoped provisioning path still succeeds on
   a later isolated checkout, with the password typed only at the physical screen.
10. Compare `/etc/labgate/ssh-host-key-sha256` to the canonical live
    `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256` fingerprint.
    Retain automated evidence that changing the server-side pin makes `node-ssh`
    reject the host before any remote command or password stdin is sent.

### E16 — Provisioning failure and compensation

1. On the isolated machine, temporarily make the exact provisioning path fail
   without changing the guest lifecycle script—for example, stop only the
   provisioner SSH reachability at the host firewall.
2. Submit checkout.
3. Require a generic provisioning failure and no password in the response/UI.
4. First test confirmed compensation: exact lock succeeds, the row becomes
   revoked/version 3, the hold is null, and release may occur.
5. Repeat with issue outcome ambiguous and compensating SSH revoke unreachable.
   Require the same credential row to remain unrevoked but immediately expired,
   machine status occupied, and `safety_hold_credential_id` equal to that exact
   ID. No password may appear in the response, UI, audit detail, or logs.
6. Replay a syntactically valid terminal close for an unrelated historical or
   unknown ID. It must return 2xx with `held`/`conflict`/`not_found`, not block the
   ordered outbox, and must not clear the hold or release the machine.
7. Restore exact SSH reachability and run the sweep/reconciliation. It must retry
   revoke for the held ID, confirm local lock, then terminalize/version 3, clear
   the hold, and release. Prove normal checkout afterward.

### E17 — Offline display without unsafe release

1. With no active reservation, stop machine heartbeat connectivity and verify the
   dashboard derives offline after roughly two minutes.
2. Restore connectivity and verify heartbeat returns it to confirmed local state.
3. Repeat while a generation is pending or active.
4. The UI may show offline, but the underlying reservation must remain occupied
   and no other student may check it out.

### E18 — Pi restart and sweep behavior

1. With an active physical session past its deadline, restart the Pi container.
2. Verify migration preflight/deploy and health succeed and the active reservation
   remains occupied after heartbeat reconciliation.
3. End the session normally.
4. Create a pending generation and let it expire while the Pi app is stopped.
5. Verify machine local cleanup reaches revoked/version 3 and queues the event.
6. Restart the Pi; outbox/heartbeat confirmation should release it.
7. Repeat with the machine unreachable and verify the Pi sweep reports retry and
   does not release it.

### E19 — Machine bootstrap, installer, PAM, sudo, and Polkit guards

Use a fresh disposable endpoint or restorable VM clone for destructive PAM-failure
branches. Keep administrator SSH and a physical/recovery console open.
The universal guest Polkit denial is intentionally compatibility-breaking for
privileged desktop broker features: `guest` loses all of them. This is a pass
condition, not a reason to add per-action exceptions.

1. Before first setup, prove `provisioner` is non-root with a unique UID, a
   root-owned non-writable home, a verified root-owned/non-writable `nologin`
   target as its shell, no processes under its real/effective UID, and no
   `authorized_keys`. Merely staging the public key under the administrator's
   `/tmp` does not authorize it. Its shadow password must already be locked.
2. Retain fixture evidence that a forced installer failure before SSH policy
   activation leaves the account at `nologin`, terminates prior provisioner
   processes, and installs no key. Then run the valid setup with no authorized
   key. It must validate/reload dispatcher, sudoers, and ForceCommand before
   changing the shell to `/bin/sh`.
3. Install the public key only after successful setup. From the Pi, prove an
   arbitrary command fails and the exact generation-scoped revoke path succeeds.
   Record the unique terminal test ID and never reuse it.
4. Record current password length, selected PAM file, detected failure-backend
   file, host-pin marker/hash, token-file hash, and unit
   state without printing the token. Copy the complete committed
   `machine-setup/` directory and rerun the installer twice with the same explicit
   settings.
5. Require no errors, unchanged webhook-token hash, same password length, exactly
   one current PAM session hook, no legacy hook, exactly one guest account-change
   guard in each `chfn`, `chsh`, and `passwd` stack, a root-owned mode-0755 helper,
   valid global sudoers/sshd, and enabled units. The installed Polkit rule must be
   byte-identical to the committed artifact at `root:root 0644`. A current-protocol
   rerun must preserve the exact live host pin and token, must not restart an already-active `RemainAfterExit` boot lock or interrupt
   a legitimate active session; test old-protocol upgrades only while drained.
6. Inventory the selected manager family. Every present known alternate path must
   contain `account requisite pam_succeed_if.so quiet user != guest`; no unknown
   matching path is allowed. Physically invoke and reject `guest` through every
   present display-manager surface: GDM `gdm-autologin`, `gdm-fingerprint`, and
   `gdm-smartcard`; LightDM `lightdm-autologin`; or SDDM `sddm-autologin`. A
   merely present PAM file is not accepted as proof—use the physical flow on the
   disposable endpoint, or record the unavailable hardware/path as an explicit
   release blocker. The primary, every present alternate, and console `login`/`su`
   paths must also deny `provisioner`; physically prove password login fails while
   its exact public-key forced command remains usable.
7. On the disposable/restorable host only, back up the PAM files, create one
   otherwise harmless unknown matching manager path, and rerun setup. It must fail
   and keep the endpoint out of service. Remove the test path, restore, and rerun
   valid setup. Separately prepend a temporary `auth required pam_fprintd.so` to
   the selected password stack, without attempting login; setup must reject it,
   including when reached through an auth include. Restore immediately and rerun
   valid setup before any login test.
8. During an isolated active guest desktop, hash the pre-test guest passwd/shadow
   records into a restricted operator variable, then attempt `passwd`, `chsh`, and
   `chfn` as non-root `guest`. All must be denied and the post-test records/hashes
   must be unchanged. If any succeeds, fail-safe secure and quarantine immediately.
9. Run the helper's no-side-effect root check from
   [OPERATIONS.md](OPERATIONS.md#reset-damaged-or-duplicated-pam-integration) to
   prove explicit root maintenance remains allowed.
10. On the restorable endpoint, accumulate enough failed guest password attempts
    to populate each selected PAM counter, then issue a new credential. The
    counter must reset and the correct new password must log in. Separately set a
    finite/expired guest aging policy as root, issue again, and require setup to
    restore minimum 0, unlimited maximum, warning 0, and no inactive/account
    expiry before successful login. Rootless failure injection must prove a
    failed `chage` or counter reset leaves `guest` locked and records recovery.
11. Capture the root-run C-locale `sudo -n -l -U guest` result. Setup must accept
    only exit 0 plus the single `User guest is not allowed to run sudo on <host>.`
    line. In the restorable fixture, add a direct guest command grant and a group/
    alias-derived grant one at a time; each installer run must fail. Also inject a
    sudoers syntax/include failure and require validation to fail before the query.
    Remove each fixture and prove valid setup again. Do not install a deny entry as
    the test—it cannot prove another rule will not override it.
12. In an active physical guest desktop, run
    `pkcheck --action-id org.freedesktop.login1.reboot --process $$ --allow-user-interaction`
    and `loginctl enable-linger guest`; both must be denied and no linger file may
    appear. Physically try every available privileged broker surface selected for
    the desktop image, at minimum system time, system-wide network configuration,
    package/software management, power control, and a privileged removable-device
    action. Record unavailable actions as blockers. No action may succeed or offer
    an administrator-authentication escape inside the shared guest session.
13. Compare controlled root and administrator Polkit decisions before/after setup;
    their host-policy behavior must be unchanged. Re-prove the provisioner's exact
    forced issue/revoke command while arbitrary commands remain rejected. The rule
    must have no non-guest return branch; it neither grants nor denies those users.
14. On the restorable host, create a regular root-owned guest linger marker, then
    perform orderly guest logout and boot-lock recovery. Both secure paths must call
    disable-linger before process cleanup and leave the marker absent. Next replace
    the marker with a directory so removal fails: local lock, termination, scratch
    cleanup, and unmount must still be attempted, but the secure operation must fail,
    record recovery, and keep the endpoint quarantined. Restore the path and rerun
    boot lock successfully.
15. Run the rootless namespace cases that seed and clear a mounted stale runtime
    tree, POSIX mqueue, all three System V IPC classes, persistent keyring data,
    exact mailbox, and scratch entry. Require a fresh mode-0700 runtime on PAM
    open. Inject runtime unmount failure and require the safety proof to fail while
    the other cleanup actions are still attempted. On the physical endpoint,
    repeat the runtime plus every supported IPC/keyring/mail surface from a real
    guest session and prove logout removes it; record an unsupported kernel
    surface as a release blocker rather than silently skipping it.
16. Complete a clean physical checkout/login/logout after all restoration. Prove
    no guest sudo grant, no linger marker, exact Polkit artifact, dormant-safe local
    state, null server hold, and no unexplained recovery/outbox backlog.

### E20 — Backup and rollback drill

1. Restore the pre-deploy SQLite backup to an isolated path and run integrity,
   foreign-key, duplicate, and migration-preflight checks against it.
2. Create and push a harmless revert commit from the development machine.
3. Pull it on a staging Pi clone with `git pull --ff-only`; do not edit tracked
   files there.
4. Build/start Compose and verify health.
5. Reapply the candidate through the same commit/push/pull path.
6. Record elapsed recovery time and any token/state reconciliation required.

### E21 — Startup and immutable registration POST guards

Use the automated preflight/registration suites plus an isolated restored database;
never corrupt the live production database for this case.

1. Prove startup rejects every missing or malformed required URL, secret, Google
   value, domain, database URL, TTL, and password-length setting. Specifically
   require registration/cron bearer length 20–256 and RFC 6750 `b64token` syntax;
   accept URL-safe values and standard Base64 containing `+`, `/`, and terminal
   `=`, while rejecting whitespace, quotes, misplaced padding, and out-of-range
   lengths. Existing valid Pi values must remain unchanged for this compatibility
   rollout.
2. Prove `PROVISIONER_SSH_KEY_PATH` rejects a relative path, missing path,
   symlink, directory, empty file, unreadable file, or loose mode such as `0644`,
   and accepts the deployed absolute readable non-empty regular mode-`0600` key.
3. Insert isolated fixtures for duplicate names, duplicate addresses, duplicate
   canonical SSH host-key pins,
   non-canonical/out-of-CGNAT addresses, duplicate current machine credentials,
   and duplicate case-normalized current student credentials. Every fixture must
   fail before migration.
4. Create `available` plus current-credential drift; preflight must fail. Create
   `available` plus non-null `safety_hold_credential_id`; preflight must also fail.
   Create `occupied` with no current credential and a held physical ID; preflight
   must succeed only with a quarantine warning and leave both occupied status and
   the exact hold unchanged. Verify the migration adds a nullable hold column and
   does not invent holds for legacy rows.
5. Register a new exact canonical name/address/Ed25519-pin triple. The inserted row must be
   `offline`, `last_heartbeat = NULL`, with a null safety hold; registration alone
   must never make it available. Capture its token only in a root-only file and
   compare hashes without printing it.
6. Repeat the exact triple POST before any heartbeat. It must return the same token and
   leave every database field unchanged, especially offline status and null
   heartbeat. Send authenticated but unsafe/contradictory heartbeat fixtures and
   prove none makes the row available. Only the strict locked, session-free,
   internally consistent safe heartbeat may set it available and record a
   heartbeat. Repeat the exact POST once more and prove it does not alter that
   status or timestamp.
7. Submit each partial collision: same name with another address or pin, same
   address with another name or pin, and same pin with another name/address. Every
   case must return `409`, preserve the original database identity/token, and
   create no extra row.
8. Prove immutable registration `POST` never changes name/address/pin, merges rows,
   or rotates the token. Those deliberate changes belong only to the separate
   drained `PATCH` case below.
9. Retain automated database-transaction evidence for both unknown active and
   unknown pending reports: every current row is terminalized, the reported ID is
   persisted as the safety hold, an unrelated terminal close preserves it, and
   exact held-ID version 3 clears/releases only when no current row remains. Also
   prove a fresh active heartbeat for a terminal row creates the hold and a
   genuinely locked no-state heartbeat is the only ID-less clearing path.

### E22 — Drained identity/token/host-pin rekey

Follow the root-only file workflow in
[OPERATIONS.md](OPERATIONS.md#drained-machine-identity-or-token-rekey) on the
isolated endpoint. A temporary name change with the same canonical physical
Tailscale IP is sufficient; do not invent an address the endpoint does not own.

1. Block student ingress, drain and boot-lock the endpoint, and prove server
   status `available` with no current credential, null safety hold, plus local
   locked/no-session/no-mount state. Back up SQLite and root-only endpoint
   configuration. A non-null hold must make `PATCH` return `409` without mutation.
2. Hash the original token without printing it. Compute the live Ed25519 pin using
   the committed helper. Submit authenticated `PATCH` from root-only curl/request
   files containing machine ID, exact expected name/address/pin, and replacement
   name/address/pin. Capture the response only in a root-only file.
3. Require one atomic result: same machine ID/history, replacement identity and pin, a
   different token hash, `last_heartbeat = NULL`, status `offline`, and one
   `machine_rekey` audit event; the safety hold remains null. The old-token
   authentication probe must return `401`; no token may appear in process
   listings, terminal output, logs, or test evidence.
4. Before installing the replacement token, verify checkout remains unavailable.
   Install the replacement pin marker and token as separate `root:root 0600`
   files, pin first, rerun the full committed setup with the
   replacement name, run boot lock, and send a heartbeat. Only a locked,
   session-free null-or-revoked safe report may move `offline` to `available`.
5. Verify immutable exact-triple `POST` is idempotent after rekey by comparing token
   hashes. It must return the same token; partial old/new identity matches must
   return `409` without mutation.
6. While a new pending credential exists, attempt a well-formed `PATCH`; require
   `409` and no identity/token/status mutation. Expire/revoke it normally.
7. Exercise interrupted handoff: retain `offline`, recover a deliberately
   discarded response via authenticated exact-triple `POST` into a root-only file,
   and complete safe-heartbeat release. Do not manually set availability.
8. In an isolated migrated database, leave one otherwise safe legacy row's pin
   SQL `NULL` and leave its endpoint token without a local marker. Normal setup
   must fail before privileged policy changes and must not POST. A drained PATCH
   with exact `expectedSshHostKeySha256: null` plus the computed non-null
   replacement pin must claim it atomically; a quoted `"null"`, omitted field, or
   nonmatching pin must fail without mutation.
9. Roll the temporary name back only through a second drained `PATCH` using the
   replacement as the exact expected identity. Require a second token rotation,
   offline hold, root-only handoff, and safe-heartbeat release. Restore student
   ingress only after SSH/PAM/dormant-safe checks pass.

### E23 — Monotonic outbox and legacy migration

First run the rootless machine protocol suite from the development checkout:

```sh
bash tests/machine-setup.test.sh
```

Require the focused cases to prove all of these independently: publication works
when `date` fails, a stale lower sequence recovers from live filenames, an
interrupted allocation leaves a gap rather than reuse, a corrupt sequence emits
nothing, and a second producer completes while the flush worker is blocked in
curl. This regression is required but does not replace endpoint validation.

On a disposable/restorable endpoint, or with a root-only copy restored into an
isolated clone, create only the exact known legacy filename/payload form described
in [OPERATIONS.md](OPERATIONS.md#migrate-a-legacy-clock-named-outbox):

1. Verify unflagged setup refuses the legacy queue without changing its files.
2. Verify a malformed filename, unsafe metadata, invalid endpoint/version, hidden
   publish remnant, or corrupt migration journal fails closed and is retained.
3. Keep a real physical session active and verify flagged migration refuses it
   without creating a journal, sequence, terminal event, or archive.
4. Log out, run boot-lock recovery, prove dormant-safe state, then rerun setup
   with `LABGATE_MIGRATE_LEGACY_OUTBOX=1`.
5. Require one `root:root 0600` version-3 terminal event per unique affected
   credential ID, a monotonically increasing sequence, terminal tombstones, no
   active legacy filename, and preserved originals under a root-only archive.
6. Interrupt a disposable migration after its journal is durable, then rerun the
   same flagged setup. The journal must resume idempotently and disappear only
   after every terminal event is durable and every remaining legacy file is
   archived.
7. Prove the flush timer is enabled again only after successful setup, all
   terminals receive 2xx and drain, Pi current credential and safety hold are
   clear, and only a fresh strict safe heartbeat makes the endpoint available.

Never manufacture this case on a student-serving endpoint and never delete or
rename a failed backlog to force the test to pass.

## UI coverage checklist

During E01–E18 exercise every implemented page and control in both desktop and
narrow viewport layouts:

- login and Google sign-in;
- protected-route redirect;
- machine list empty/loading/error/available/occupied/offline states;
- checkout action and concurrent/409 failure;
- credential display, exact countdown, password hide at pending expiry, and
  no password on errors;
- active-session messaging after the original deadline;
- refresh/reconnect behavior after webhooks or heartbeat changes;
- logout; and
- keyboard focus, disabled buttons, error text, and repeated-click behavior.

Browser automation may cover repeatable UI behavior, but it does not replace the
physical keyboard/display cases. Record every defect in a Markdown audit artifact
without credentials or tokens.

## Final release decision

Release only when:

- every required matrix row passes or has an approved, time-bounded blocker in
  `PROGRESS.md`;
- no password, bearer, key, or OAuth token appears in evidence;
- app and machine password lengths match;
- pending expiry and active-after-deadline behavior are both physically proven;
- all three versions and wrong-generation protection are observed;
- unexpected active/pending, terminal-active, and ambiguous-provision safety
  holds persist across unrelated closes and clear only through exact terminal or
  genuinely safe no-state confirmation;
- guest SSH denial and administrator SSH continuity pass;
- provisioner nologin-first/key-last bootstrap, public-key/environment/home/
  shell/absolute-sudo boundaries, locked password/physical PAM denial, and
  one-line password-stdin protocol pass;
- supported/unknown display-manager paths, selected-stack fingerprint rejection,
  failure-counter/aging reset, and guest `passwd`/`chsh`/`chfn` guards pass;
- bounded guest runtime, scratch, IPC, persistent-keyring, and mailbox cleanup
  passes, including a fail-closed cleanup fault;
- outbox, cleanup, heartbeat, boot lock, and Pi sweep each recover their intended
  failure mode;
- startup drift quarantine/failure, immutable pinned registration `POST`, exact
  Ed25519 SSH host verification, and drained rekey/offline-safe-heartbeat behavior
  (including legacy-null CAS) pass; and
- the machine returns to dormant-safe state.

Any failure to lock, terminate guest-owned processes, clear a bounded persistence
surface, unmount the tmpfs, preserve an active session, verify the SSH host pin,
or withhold availability without proof is a release blocker.
