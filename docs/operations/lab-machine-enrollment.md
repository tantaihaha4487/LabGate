# Enroll a lab machine

[Operations index](README.md) · [Documentation hub](../README.md) · [Back to README](../../README.md)

Run this procedure once per physical Ubuntu Desktop endpoint. The interactive
installer adds the required Ubuntu packages, connects Tailscale, verifies the Pi,
creates the constrained infrastructure identity, applies the reviewed machine
policy, registers the endpoint, and installs the provisioning public key last.

## Before starting

Deploy the same reviewed LabGate commit on the Pi first. Its public health route
must advertise machine-enrollment protocol version 1, and the protected Pi
configuration must contain `MACHINE_REGISTRATION_SECRET`.

Keep the provisioning private key on the Pi. Display and copy only its one-line
public key; the installer will ask you to paste it:

```sh
cd ~/LabGate
cat secrets/provisioner_key.pub
```

Use an Ubuntu Desktop administrator terminal on the lab machine. A wired network
connection is recommended because package and Tailscale installation can restart
network-facing services.

## One-shot installation

Run:

```sh
curl -fsSL https://raw.githubusercontent.com/tantaihaha4487/LabGate/main/machine-setup/install-machine.sh | sudo bash
```

The script reads interactive values from `/dev/tty`, so prompts continue to work
even though Bash is reading the installer from the curl pipe. It asks for:

- the Pi API origin, such as `http://100.64.0.5:3000` or an HTTPS tailnet name;
- one unique machine name;
- the exact guest password length, normally `8`;
- the machine-registration secret without echoing it;
- an optional Tailscale auth key without echoing it, or it starts the normal
  interactive Tailscale login; and
- the Pi's one-line `ssh-ed25519` provisioning public key.

Before confirmation, the preview resembles:

```text
LabGate physical machine installer
Mode:                Fresh enrollment
Source revision:     0123456789abcdef0123456789abcdef01234567
Target OS:           Ubuntu Desktop confirmed
Machine:             Lab A - PC 01
Pi API:              http://100.64.0.5:3000
Pi preflight:        health and enrollment compatibility will be checked
Password length:     8
Tailscale:           installation or tailnet login required
Provisioner key:     SHA256:REDACTED
Registration key:    supplied (hidden)

Planned changes:
  1. Install the fixed Ubuntu prerequisites and verify clock/SSH.
  2. Connect this endpoint to Tailscale.
  3. Verify the Pi health endpoint and enrollment protocol v1.
  4. Authenticate registration readiness without changing Pi data.
  5. Apply the reviewed guest, PAM, Polkit, sudoers, SSH, and timer policy.
  6. Publish the provisioner key only after hardened setup succeeds.

Continue? [y/N]:
```

After confirmation, the installer prints eight numbered stages. It checks
`/api/health`, then sends the registration secret from a root-only temporary curl
configuration to the read-only registration-readiness endpoint. A timeout,
redirect, TLS error, unhealthy database, incompatible API version, or rejected
secret stops enrollment before the provisioner identity or local PAM/SSH policy
is changed.

A successful run ends with a redacted summary similar to:

```text
LabGate machine installation complete
Machine:                 Lab A - PC 01
Pi enrollment API:       healthy; protocol v1
Registration access:     accepted
Tailscale address:       100.92.10.14
SSH host-key pin:        SHA256:REDACTED
Provisioner key:         SHA256:REDACTED
Guest account:           locked
Lifecycle timers:        enabled and active
```

The endpoint begins offline. The installer attempts one safe heartbeat, but the
operator must still confirm that the dashboard changes it to available and then
complete the physical acceptance checks. Installation success alone does not
complete Phase 8.

## Preview, pinned, and local modes

Preview without host or Pi mutation:

```sh
curl -fsSL https://raw.githubusercontent.com/tantaihaha4487/LabGate/main/machine-setup/install-machine.sh | bash -s -- --dry-run
```

Pin machine-side assets to one reviewed commit:

```sh
curl -fsSL https://raw.githubusercontent.com/tantaihaha4487/LabGate/main/machine-setup/install-machine.sh | sudo bash -s -- --commit COMMIT_SHA
```

When the complete reviewed repository was copied locally, avoid GitHub downloads:

```sh
sudo ./machine-setup/install-machine.sh --local
```

The default network mode resolves `main` to one immutable commit before it
downloads any machine-side assets. The local mode validates the complete adjacent
asset set and shell syntax before showing prompts.

## Safe reruns and reviewed exceptions

Rerunning the installer on an endpoint with a valid webhook-token and host-pin
pair uses update mode. It reuses the existing identity and authorized key and
checks Pi health without requiring the global registration secret. An empty or
symlinked identity, an unexpected pre-enrollment authorized key, a missing
provisioner on an enrolled machine, a changed SSH host key, or any other ambiguous
state fails closed.

The one-shot path intentionally does not expose legacy-outbox migration, PAM-file
overrides, drained identity rekey, or key rotation. Follow the recovery guide and
run the reviewed `setup-machine.sh` flow directly for those maintenance cases.

See [AGENTS.md](../../AGENTS.md) before changing machine-side security policy.
