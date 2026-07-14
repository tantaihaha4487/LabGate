# Install the Raspberry Pi

[Operations index](README.md) · [Documentation hub](../README.md) · [Back to README](../../README.md)

Install a supported 64-bit Raspberry Pi OS with Git, Docker Engine, the Compose
plugin, Tailscale, `sqlite3`, and time synchronization. Join the Pi to the same
tailnet as every lab machine.

```sh
docker --version
docker compose version
tailscale status
tailscale ip -4
timedatectl status
```

Clone the reviewed repository and create protected directories:

```sh
git clone https://github.com/tantaihaha4487/LabGate.git ~/LabGate
cd ~/LabGate
install -d -m 700 data secrets backups
```

Create the dedicated provisioning key on the Pi. Keep the private key on the
Pi; only its `.pub` file is copied to lab machines.

```sh
ssh-keygen -t ed25519 -f secrets/provisioner_key -N '' -C labgate-provisioner
chmod 600 secrets/provisioner_key
chmod 644 secrets/provisioner_key.pub
```

Continue with [configuration](configuration.md).
