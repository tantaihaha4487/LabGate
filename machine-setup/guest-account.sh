#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
readonly PASSWORD_PATTERN='^[A-HJ-NP-Za-km-z2-9]{12,128}$'

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
    printf 'guest:%s\n' "${password}" | chpasswd
    passwd -u guest >/dev/null
    ;;
  revoke)
    [[ $# -eq 1 ]] || die "usage: guest-account.sh revoke"
    passwd -l guest >/dev/null
    ;;
  *)
    die "action must be issue or revoke"
    ;;
esac
