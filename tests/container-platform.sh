#!/usr/bin/env bash
set -euo pipefail
cd /work
source machine-setup/labgate-platform.sh
source /etc/os-release
os_family=$(labgate_classify_platform "${ID:-}" "${ID_LIKE:-}")
os_family_label=${os_family}
# Run the actual dependency functions, without starting the full installer.
source <(sed -n '/^install_apt_dependencies()/,/^install_platform_dependencies()/p' machine-setup/install-machine.sh | sed '$d')
require_command() { command -v "$1" >/dev/null || { printf 'Missing command: %s\n' "$1" >&2; exit 1; }; }
die() { printf '%s\n' "$1" >&2; exit 1; }
run_child_command() { "$@"; }
if [[ ${os_family} == arch ]]; then
  # A fresh disposable rolling image is brought current before exercising -S.
  pacman -Syu --noconfirm
  install_arch_dependencies
else
  install_apt_dependencies
fi
printf 'u guest - "Disposable LabGate test account" /home/guest /bin/bash\n' >/tmp/labgate-test-users.conf
systemd-sysusers /tmp/labgate-test-users.conf
LABGATE_CONTAINER_PASSWORD_TEST=1 /machine-tests -test.v
ssh-keygen -q -t ed25519 -N '' -f /tmp/test-provisioner
LABGATE_API_URL=https://labgate.example.edu LABGATE_MACHINE_NAME='Test desktop' \
 LABGATE_PASSWORD_LENGTH=8 LABGATE_KEEP_GUEST_HOME=n LABGATE_INSTALL_NONINTERACTIVE=1 \
 LABGATE_REGISTRATION_SECRET=fixture-registration-secret-abcdefghijklmnopqrstuvwxyz \
 TAILSCALE_AUTH_KEY=fixture-only-key LABGATE_PROVISIONER_PUBLIC_KEY_FILE=/tmp/test-provisioner.pub \
 bash /work/dist/labgate-linux-amd64/machine-setup/install-machine.sh --dry-run --local
[[ ! -e /etc/labgate/webhook-token ]]
bash /work/dist/labgate-linux-amd64/install.sh client
/usr/local/bin/labgate version
/work/bin/labgate version
/work/bin/labgate-migrate --database /tmp/platform.db --dry-run
[[ ! -e /tmp/platform.db ]]
/work/bin/labgate-migrate --database /tmp/platform.db
printf 'PASS: %s prerequisites, real password utilities, helper tests, installer dry-run, client installation and Go executables\n' "${PRETTY_NAME}"
