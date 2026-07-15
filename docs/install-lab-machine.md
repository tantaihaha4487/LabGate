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
# Pi
cd ~/LabGate
cat secrets/provisioner_key.pub
~~~

Keep the private key on the Pi. Never paste it into a machine or put it in a
machine command line.

The target needs an administrator identity, a working display manager, OpenSSH
Server, PAM, Polkit, systemd, and network access. Ubuntu uses <code>apt</code>. Arch Linux
and derivatives with <code>ID_LIKE=arch</code> use <code>pacman -Syu</code> because Arch does not
support partial upgrades.

## One-shot enrollment

Run this from the physical machine. The installer reads prompts from
<code>/dev/tty</code>, including secrets without echo.

~~~sh
# Physical lab machine
curl -fsSL https://raw.githubusercontent.com/tantaihaha4487/LabGate/main/machine-setup/install-machine.sh | sudo bash
~~~

Supply the Pi API origin, a unique machine name, the exact guest password
length, the registration secret, an optional Tailscale auth key, and the Pi's
one-line <code>ssh-ed25519</code> public key. The API origin must be canonical HTTP(S) with
one DNS hostname or IPv4 address and an optional non-default port; paths,
userinfo, query strings, fragments, IPv6, whitespace, and a trailing slash are
rejected.

The installer checks <code>/api/health</code> and the authenticated registration-readiness
endpoint before mutating the provisioner, guest, PAM, Polkit, sudoers, or SSH
policy. It starts the provisioner with verified <code>nologin</code>, keeps its password
locked, and installs its authorized key only after the forced-command boundary
passes validation. It never creates a per-student OS account.

The new endpoint starts <code>offline</code>. A safe heartbeat is attempted, but that is not
physical acceptance: verify the dashboard state and complete the checklist in
[recovery and acceptance](recovery.md).

## Preview and pin the source

Preview without host or Pi mutation:

~~~sh
# Physical lab machine
curl -fsSL https://raw.githubusercontent.com/tantaihaha4487/LabGate/main/machine-setup/install-machine.sh | bash -s -- --dry-run
~~~

Use one reviewed lowercase 40-character commit SHA:

~~~sh
# Physical lab machine
curl -fsSL https://raw.githubusercontent.com/tantaihaha4487/LabGate/main/machine-setup/install-machine.sh | sudo bash -s -- --commit <COMMIT_SHA>
~~~

When the complete reviewed checkout is already on the machine:

~~~sh
# Physical lab machine
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
