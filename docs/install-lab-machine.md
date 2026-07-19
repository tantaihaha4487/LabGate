# Install and enroll a lab machine

[Docs home](README.md) · [Pi install](install-pi.md) · [Lab machine install](install-lab-machine.md)

Run this procedure from an administrator terminal on each physical Ubuntu
Desktop or Arch-family desktop. The installer installs prerequisites, connects
Tailscale, checks the Pi, applies the hardened machine policy, registers the
endpoint, and publishes the provisioning public key last.

## Before starting

On the Pi, deploy the same reviewed LabGate commit first. Confirm that the Pi's
health endpoint advertises enrollment protocol version 1 and that
<code>MACHINE_REGISTRATION_SECRET</code> is configured.

On the Pi, display only the public key:

~~~sh
cd ~/LabGate
cat secrets/provisioner_key.pub
~~~

Keep the private key on the Pi. Never paste it into a machine or put it in a
machine command line.

The target needs an administrator identity, a working display manager, OpenSSH
Server, PAM, Polkit, systemd, and network access. Ubuntu uses <code>apt</code>. Arch Linux
and derivatives with <code>ID_LIKE=arch</code> use <code>pacman -S --needed</code> only for
missing LabGate prerequisites; the installer does not run a full system upgrade.

## One-shot enrollment

Run this from the physical machine. The installer reads prompts from
<code>/dev/tty</code>, including secrets without echo.

~~~sh
curl -fsSL https://raw.githubusercontent.com/tantaihaha4487/LabGate/main/machine-setup/install-machine.sh | sudo bash
~~~

Copy only the command above. In interactive zsh, a copied line beginning with
<code>#</code> can produce <code>zsh: command not found: #</code>; that message comes from the
shell before LabGate starts and does not indicate an installer failure.

Supply the Pi API origin, a unique machine name, the exact guest password
length, the registration secret, an optional Tailscale auth key, and the Pi's
one-line <code>ssh-ed25519</code> public key. The API origin must be canonical HTTP(S) with
one DNS hostname or IPv4 address and an optional non-default port; paths,
userinfo, query strings, fragments, IPv6, whitespace, and a trailing slash are
rejected.

The installer also asks <code>Keep /home/guest contents between sessions? [y/N]:</code>.
Answer <code>y</code> for a persistent disk-backed home or <code>n</code> (or Enter on
fresh enrollment) for a fresh tmpfs home. On reruns, Enter preserves the existing
root-owned <code>/etc/labgate/guest-home-mode</code> setting. Noninteractive runs may
set <code>LABGATE_KEEP_GUEST_HOME=y</code> or <code>n</code>. Changing the setting is
allowed only while the machine is locked, session-free, process-free, safely
unmounted, and has no guest linger marker.

Interactive values are validated immediately. A typo is explained and the same
question is asked again without advancing to secret input or confirmation. The
password length must be 5-128; use 8 unless the Pi is intentionally configured
with the same different value. For example, <code>4</code> is rejected and reprompted.

Color is enabled automatically on an interactive terminal. Redirected output,
<code>TERM=dumb</code>, or <code>NO_COLOR</code> produces plain text suitable for logs. Set
<code>LABGATE_INSTALL_COLOR=always</code> or <code>LABGATE_INSTALL_COLOR=never</code> only when a
calling terminal or log collector needs an explicit mode. The examples below
are plain text; the live terminal uses cyan headings and stage markers, blue
labels and prompts, dim prefixed child output, green results, yellow operator
actions, and red input or stage failures.

Sudo messages, package-manager details, and interactive Tailscale login messages
vary with the host. Each representative transcript uses one explicit
continuation marker for variable package output. Registration and Tailscale
secrets remain hidden.

### Complete Ubuntu Desktop example

~~~text
$ curl -fsSL https://raw.githubusercontent.com/tantaihaha4487/LabGate/main/machine-setup/install-machine.sh | sudo bash
Pi LabGate API origin: http://100.64.0.5:3000
Unique machine name [lab-pc-01]: Lab A - PC 01
Guest password length (5-128; normally 8) [8]:
Keep /home/guest contents between sessions? [y/N]:
Machine registration secret:
Tailscale auth key (optional; press Enter to skip):
Paste the Pi provisioner Ed25519 public key: ssh-ed25519 REDACTED

LabGate physical machine installer
Mode:                Fresh enrollment
Source revision:     0123456789abcdef0123456789abcdef01234567
Target OS:           Ubuntu Desktop confirmed
Machine:             Lab A - PC 01
Pi API:              http://100.64.0.5:3000
Pi preflight:        health and enrollment compatibility will be checked
Password length:     8
Tailscale:           installation or tailnet login required; auth key supplied (hidden)
Provisioner key:     SHA256:REDACTED
Registration key:    supplied (hidden)

Planned changes
  1. Install the fixed Ubuntu prerequisites and verify clock/SSH.
  2. Connect this endpoint to Tailscale.
  3. Verify the Pi health endpoint and enrollment protocol v1.
  4. Authenticate registration readiness without changing Pi data.
  5. Apply the reviewed guest, PAM, Polkit, sudoers, SSH, and lifecycle-trigger policy.
  6. Publish the provisioner key only after hardened setup succeeds.

Continue? [y/N]: y

[1/8] Installing Ubuntu prerequisites
| Hit:1 http://archive.ubuntu.com/ubuntu ...
| Reading package lists... Done
| Building dependency tree... Done
| ... additional apt output varies by package and Ubuntu release ...
[OK] Ubuntu prerequisites installed.

[2/8] Verifying clock synchronization and administrator SSH
[OK] Clock synchronized; administrator SSH is active and valid.

[3/8] Connecting the endpoint to Tailscale
[OK] Tailscale connected at 100.92.10.14.

[4/8] Checking the Pi health and enrollment endpoints
[OK] Pi enrollment API is healthy; protocol v1.
[OK] Registration access accepted.

[5/8] Preparing the locked provisioner boundary
[OK] Locked provisioner boundary prepared.

[6/8] Applying the hardened LabGate machine setup
| LabGate machine setup complete for Lab A - PC 01 (100.92.10.14); password length is 8.
[OK] Guest, PAM, Polkit, sudoers, SSH, and lifecycle-trigger policy applied.

[7/8] Publishing the key last and sending a safe heartbeat
[OK] Provisioner key published; initial safe heartbeat service completed.

[8/8] Verifying the Pi endpoint after installation
[OK] Pi endpoint remains healthy; protocol v1.

LabGate machine installation complete
Machine:                 Lab A - PC 01
Pi enrollment API:       healthy; protocol v1
Registration access:     accepted
Tailscale address:       100.92.10.14
SSH host-key pin:        SHA256:REDACTED
Provisioner key:         SHA256:REDACTED
Guest account:           locked
Lifecycle triggers:      path and timers enabled and active
Initial heartbeat:       local service completed

Required operator actions
  1. Confirm the LabGate dashboard shows this machine as available.
  2. Complete physical login, active-session, logout, cleanup, and expiry checks.
  3. Record the evidence before allowing student use.
Manual shell commands: none; the initial heartbeat service already ran.
Checklist: https://github.com/tantaihaha4487/LabGate/blob/0123456789abcdef0123456789abcdef01234567/docs/recovery.md#physical-acceptance
~~~

### Complete EndeavourOS example

~~~text
$ curl -fsSL https://raw.githubusercontent.com/tantaihaha4487/LabGate/main/machine-setup/install-machine.sh | sudo bash
Pi LabGate API origin: https://raspberrypi.example.ts.net
Unique machine name [lab-pc-02]: Lab A - PC 02
Guest password length (5-128; normally 8) [8]:
Keep /home/guest contents between sessions? [y/N]:
Machine registration secret:
Tailscale auth key (optional; press Enter to skip):
Paste the Pi provisioner Ed25519 public key: ssh-ed25519 REDACTED

LabGate physical machine installer
Mode:                Fresh enrollment
Source revision:     fedcba9876543210fedcba9876543210fedcba98
Target OS:           EndeavourOS (Arch family) confirmed
Machine:             Lab A - PC 02
Pi API:              https://raspberrypi.example.ts.net
Pi preflight:        health and enrollment compatibility will be checked
Password length:     8
Tailscale:           installation or tailnet login required; auth key supplied (hidden)
Provisioner key:     SHA256:REDACTED
Registration key:    supplied (hidden)

Planned changes
  1. Install missing Arch prerequisites without a full system upgrade, then verify clock/SSH.
  2. Connect this endpoint to Tailscale.
  3. Verify the Pi health endpoint and enrollment protocol v1.
  4. Authenticate registration readiness without changing Pi data.
  5. Apply the reviewed guest, PAM, Polkit, sudoers, SSH, and lifecycle-trigger policy.
  6. Publish the provisioner key only after hardened setup succeeds.

Continue? [y/N]: y

[1/8] Installing Arch prerequisites
| ... pacman output varies when missing prerequisites are installed ...
[OK] Arch prerequisites installed; no full system upgrade was run.

[2/8] Verifying clock synchronization and administrator SSH
[OK] Clock synchronized; administrator SSH is active and valid.

[3/8] Connecting the endpoint to Tailscale
[OK] Tailscale connected at 100.92.10.15.

[4/8] Checking the Pi health and enrollment endpoints
[OK] Pi enrollment API is healthy; protocol v1.
[OK] Registration access accepted.

[5/8] Preparing the locked provisioner boundary
[OK] Locked provisioner boundary prepared.

[6/8] Applying the hardened LabGate machine setup
| LabGate machine setup complete for Lab A - PC 02 (100.92.10.15); password length is 8.
[OK] Guest, PAM, Polkit, sudoers, SSH, and lifecycle-trigger policy applied.

[7/8] Publishing the key last and sending a safe heartbeat
[OK] Provisioner key published; initial safe heartbeat service completed.

[8/8] Verifying the Pi endpoint after installation
[OK] Pi endpoint remains healthy; protocol v1.

LabGate machine installation complete
Machine:                 Lab A - PC 02
Pi enrollment API:       healthy; protocol v1
Registration access:     accepted
Tailscale address:       100.92.10.15
SSH host-key pin:        SHA256:REDACTED
Provisioner key:         SHA256:REDACTED
Guest account:           locked
Lifecycle triggers:      path and timers enabled and active
Initial heartbeat:       local service completed

Required operator actions
  1. Confirm the LabGate dashboard shows this machine as available.
  2. Complete physical login, active-session, logout, cleanup, and expiry checks.
  3. Record the evidence before allowing student use.
Manual shell commands: none; the initial heartbeat service already ran.
Checklist: https://github.com/tantaihaha4487/LabGate/blob/fedcba9876543210fedcba9876543210fedcba98/docs/recovery.md#physical-acceptance
~~~

The installer checks <code>/api/health</code> and the authenticated registration-readiness
endpoint before mutating the provisioner, guest, PAM, Polkit, sudoers, or SSH
policy. It starts the provisioner with verified <code>nologin</code>, keeps its password
locked, and installs its authorized key only after the forced-command boundary
passes validation. It never creates a per-student OS account.

The new endpoint starts <code>offline</code>. The installer runs the initial heartbeat
service after local setup, but that is not physical acceptance: verify the
dashboard state and complete the checklist in [recovery and
acceptance](recovery.md). If the heartbeat service itself fails, inspect it with
the exact commands printed by the installer, correct the cause, and start it
again. Any other failed stage links to the same recovery guide. Do not allow
student use after a failed stage.

## Preview and pin the source

Preview without host or Pi mutation:

~~~sh
curl -fsSL https://raw.githubusercontent.com/tantaihaha4487/LabGate/main/machine-setup/install-machine.sh | bash -s -- --dry-run
~~~

Use one reviewed lowercase 40-character commit SHA:

~~~sh
curl -fsSL https://raw.githubusercontent.com/tantaihaha4487/LabGate/main/machine-setup/install-machine.sh | sudo bash -s -- --commit <COMMIT_SHA>
~~~

When the complete reviewed checkout is already on the machine:

~~~sh
sudo ./machine-setup/install-machine.sh --local
~~~

The normal network mode resolves <code>main</code> to one immutable commit before
downloading machine-side assets. <code>--local</code> validates the adjacent asset set and
shell syntax before prompting.

## Updates and exceptions

Rerunning an enrolled endpoint is update mode when its root-only webhook-token
and Ed25519 host-key pin are intact. The identity, token, and authorized key are
preserved; the global registration secret is not required. A changed host key,
missing identity, unexpected authorized key, malformed token, or ambiguous state
fails closed.

Legacy outbox migration, a display-manager PAM override, drained identity rekey,
and key rotation are reviewed maintenance operations. Keep the endpoint drained
and follow [recovery](recovery.md); do not improvise by deleting state or tokens.

See [AGENTS.md](../AGENTS.md) for the binding machine security contract. Continue
to [recovery and physical acceptance](recovery.md).
