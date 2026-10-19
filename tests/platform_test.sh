#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
source machine-setup/labgate-platform.sh
check() { [[ $(labgate_classify_platform "$1" "$2") == "$3" ]] || { printf 'Wrong platform: %s\n' "$1" >&2; exit 1; }; }
check debian '' debian
check raspbian debian debian
check ubuntu debian ubuntu
check arch '' arch
check endeavouros arch arch
check manjaro 'arch linux' arch
check custom 'linux debian' debian
if labgate_classify_platform fedora 'rhel fedora' >/dev/null; then exit 1; fi
loaded_unit=sshd.service
systemctl() { if [[ $2 == "${loaded_unit}" ]]; then printf 'loaded\n'; else printf 'not-found\n'; fi; }
[[ $(labgate_sshd_unit) == sshd.service ]]
loaded_unit=ssh.service
[[ $(labgate_sshd_unit) == ssh.service ]]
loaded_unit=none
if labgate_sshd_unit >/dev/null; then exit 1; fi
printf 'PASS: Debian, Raspberry Pi OS, Ubuntu, Arch and derivatives classified correctly\n'

installed_provider=chrony
dpkg-query() { [[ $3 == "${installed_provider}" ]] && printf 'install ok installed'; }
if labgate_needs_timesyncd; then exit 1; fi
installed_provider=none
labgate_needs_timesyncd
