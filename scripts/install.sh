#!/usr/bin/env bash
set -euo pipefail
release=$(cd -- "$(dirname -- "$0")" && pwd)
case $(uname -s) in Linux) ;; *) printf 'LabGate currently supports Linux.\n' >&2; exit 1;; esac
case $(uname -m) in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; *) printf 'Unsupported architecture.\n' >&2; exit 1;; esac
[[ -f ${release}/SHA256SUMS ]] || { printf 'Run this installer from the extracted release archive.\n' >&2; exit 1; }
(cd "${release}" && sha256sum --check --quiet SHA256SUMS)
[[ ${release##*/} == "labgate-linux-${arch}" ]] || { printf 'Download the %s release for this machine.\n' "${arch}" >&2; exit 1; }
[[ -r /etc/os-release ]] || { printf 'Cannot detect Linux distribution.\n' >&2; exit 1; }
source /etc/os-release
source "${release}/machine-setup/labgate-platform.sh"
family=$(labgate_classify_platform "${ID:-}" "${ID_LIKE:-}" || true)
[[ -n ${family} ]] || { printf 'Supported distributions: Debian/Raspberry Pi OS, Ubuntu, and Arch families.\n' >&2; exit 1; }
printf 'Detected %s (%s).\n' "${PRETTY_NAME:-${ID}}" "${arch}"
role=${1:-}
if [[ -z ${role} ]]; then
  printf 'Install LabGate:\n  1) Pi / server\n  2) Admin client\n  3) Lab machine\n'
  read -r -p 'Choose [1–3]: ' role
fi
case ${role} in
  1|server)
    [[ ${EUID} -eq 0 ]] || exec sudo -- "$0" server
    command -v systemctl >/dev/null || { printf 'systemd is required.\n' >&2; exit 1; }
    command -v systemd-sysusers >/dev/null || { printf 'systemd-sysusers is required.\n' >&2; exit 1; }
    install -d -m 0755 /etc/sysusers.d
    install -m 0755 "${release}/labgate" "${release}/labgate-migrate" /usr/local/bin/
    printf 'u labgate-server - "LabGate server" /var/lib/labgate-server /usr/sbin/nologin\n' >/etc/sysusers.d/labgate-server.conf
    systemd-sysusers /etc/sysusers.d/labgate-server.conf
    install -d -o labgate-server -g labgate-server -m 0700 /var/lib/labgate-server
    /usr/local/bin/labgate setup --server
    chown root:labgate-server /etc/labgate
    chmod 0750 /etc/labgate
    chown labgate-server:labgate-server /etc/labgate/server.json /etc/labgate/provisioner_key
    cat >/etc/systemd/system/labgate.service <<'UNIT'
[Unit]
Description=LabGate server
After=network-online.target tailscaled.service
Wants=network-online.target
[Service]
User=labgate-server
Group=labgate-server
ExecStart=/usr/local/bin/labgate serve
WorkingDirectory=/var/lib/labgate-server
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/labgate-server
[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    if /usr/local/bin/labgate check >/dev/null 2>&1; then
      systemctl enable --now labgate
      printf 'Installed and started with the existing prepared database.\n'
      exit 0
    fi
    printf '\nInstalled. Database creation/upgrade is ALWAYS a separate explicit operation:\n  sudo -u labgate-server labgate-migrate\nThen start the prepared service:\n  sudo systemctl enable --now labgate\n'
    ;;
  2|client)
    [[ ${EUID} -eq 0 ]] || exec sudo -- "$0" client
    command -v systemd-sysusers >/dev/null || { printf 'systemd-sysusers is required.\n' >&2; exit 1; }
    install -d -m 0755 /etc/sysusers.d
    install -m 0755 "${release}/labgate" /usr/local/bin/labgate
    printf 'Installed. Run labgate as your normal user to connect and sign in.\n'
    ;;
  3|machine)
    [[ ${EUID} -eq 0 ]] || exec sudo -- "$0" machine
    install -m 0755 "${release}/labgate" /usr/local/bin/labgate
    exec bash "${release}/machine-setup/install-machine.sh" --local
    ;;
  *) printf 'Choose server, client, or machine.\n' >&2; exit 1;;
esac
