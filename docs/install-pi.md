# Install the Raspberry Pi

[Docs home](README.md) · [Pi install](install-pi.md) · [Lab machine install](install-lab-machine.md)

Run these commands on the Raspberry Pi. Use a supported 64-bit Raspberry Pi OS
installation with an administrator account, working time synchronization, and
network access to the tailnet.

## Prerequisites

Install or verify Git, Docker Engine with the Compose plugin, Tailscale,
<code>sqlite3</code>, and time synchronization. The Pi and every physical machine must be
members of the same Tailscale network.

~~~sh
# Pi
docker --version
docker compose version
tailscale status
tailscale ip -4
timedatectl status
~~~

The Pi must be reachable from the development machine over its administrator
SSH path. Keep that path available during machine enrollment and recovery.

## Clone and protect the runtime directories

~~~sh
# Pi
git clone https://github.com/tantaihaha4487/LabGate.git ~/LabGate
cd ~/LabGate
install -d -m 700 data secrets backups
~~~

Create the dedicated provisioning key on the Pi. Keep the private key here; only
the public key is pasted into a physical machine installer.

~~~sh
# Pi
ssh-keygen -t ed25519 -f secrets/provisioner_key -N '' -C labgate-provisioner
chmod 600 secrets/provisioner_key
chmod 644 secrets/provisioner_key.pub
~~~

Do not copy <code>secrets/provisioner_key</code> to a lab machine. Do not put it in Git,
<code>.env.local</code>, shell history, or a command argument.

## Verify the host

~~~sh
# Pi
test -f Dockerfile
test -f docker-compose.yml
test -f .env.example
test -f secrets/provisioner_key
stat -c '%a %n' secrets/provisioner_key
~~~

Continue with [configuration](configuration.md), then enroll each endpoint with
the [lab-machine installer](install-lab-machine.md).
