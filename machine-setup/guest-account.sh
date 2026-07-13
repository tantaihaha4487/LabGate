#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
readonly PASSWORD_PATTERN='^[A-HJ-NP-Za-km-z2-9]{8,128}$'
readonly STATE_DIRECTORY=/var/lib/labgate
readonly ISSUED_TIMESTAMP=${STATE_DIRECTORY}/credential-issued-at

die() {
  printf 'guest-account: %s\n' "$1" >&2
  exit 64
}

[[ ${EUID} -eq 0 ]] || die "must run as root"
getent passwd guest >/dev/null || die "guest account does not exist"

case "${1:-}" in
  issue)
    [[ $# -eq 2 ]] || die "usage: guest-account.sh issue <password>"
    password=$2
    [[ ${password} =~ ${PASSWORD_PATTERN} ]] || die "invalid password"
    install -d -o root -g root -m 0700 "${STATE_DIRECTORY}"
    date +%s >"${ISSUED_TIMESTAMP}"
    printf 'guest:%s\n' "${password}" | chpasswd
    passwd -u guest >/dev/null
    ;;
  revoke)
    [[ $# -eq 1 ]] || die "usage: guest-account.sh revoke"
    passwd -l guest >/dev/null
    rm -f "${ISSUED_TIMESTAMP}"
    ;;
  *)
    die "action must be issue or revoke"
    ;;
esac
