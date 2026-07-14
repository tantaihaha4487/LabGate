# Enroll a lab machine

[Operations index](README.md) · [Full reference](../OPERATIONS.md) · [Back to README](../../README.md)

Run this procedure once per physical Ubuntu Desktop endpoint. Each endpoint
needs Tailscale, OpenSSH Server, PAM, Polkit, systemd, `curl`, `sudo`, `keyctl`,
an administrator account, and a locked `provisioner` account with no key yet.

From the Pi, copy only the public key and setup directory:

```sh
scp secrets/provisioner_key.pub ADMIN@MACHINE:/tmp/labgate-provisioner.pub
scp -r machine-setup ADMIN@MACHINE:/tmp/labgate-machine-setup
```

On the endpoint, run as root with a unique name:

```sh
sudo bash
read -rsp 'Machine registration secret: ' LABGATE_REGISTRATION_SECRET
printf '\\n'
export LABGATE_REGISTRATION_SECRET
export LABGATE_API_URL='http://PI_TAILSCALE_ADDRESS:3000'
export LABGATE_MACHINE_NAME='Lab A - PC 01'
export LABGATE_PASSWORD_LENGTH='8'
bash /tmp/labgate-machine-setup/setup-machine.sh
unset LABGATE_REGISTRATION_SECRET
exit
```

Install the staged public key only after setup succeeds. Repeat with a different
machine name for Machine 2. The installer detects each endpoint's Tailscale IP
and SSH host-key pin and obtains a separate webhook token.

See the [complete enrollment reference](../OPERATIONS.md#3-enroll-a-lab-machine).
