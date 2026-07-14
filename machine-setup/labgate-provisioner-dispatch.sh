#!/bin/sh
set -eu

# sshd invokes ForceCommand through the provisioner's login shell. Reset the
# complete execution environment before parsing the only two accepted command
# shapes; do not rely on a caller-controlled PATH or shell startup file.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
IFS=' '
export PATH LC_ALL
unset ENV BASH_ENV CDPATH GLOBIGNORE SHELLOPTS 2>/dev/null || true
umask 077

ACCOUNT_SCRIPT=/usr/local/sbin/guest-account.sh

deny() {
  printf '%s\n' 'LabGate provisioner command denied.' >&2
  exit 126
}

is_credential_id() {
  value=${1-}
  case "${value}" in
    ''|*[!A-Za-z0-9_-]*) return 1 ;;
  esac
  length=${#value}
  [ "${length}" -ge 20 ] && [ "${length}" -le 64 ]
}

is_unix_time() {
  value=${1-}
  case "${value}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  length=${#value}
  [ "${length}" -le 12 ]
}

is_password() {
  value=${1-}
  case "${value}" in
    ''|*[!A-HJ-NP-Za-km-z2-9]*) return 1 ;;
  esac
  length=${#value}
  [ "${length}" -ge 8 ] && [ "${length}" -le 128 ]
}

original=${SSH_ORIGINAL_COMMAND-}
case "${original}" in
  ''|*[!A-Za-z0-9_./\ -]*) deny ;;
esac

# The character allow-list above excludes glob characters, tabs, line breaks,
# quotes, expansions, and redirections, so this split cannot invoke the shell.
# Requiring the reconstructed command to match also rejects leading, trailing,
# or repeated spaces.
# shellcheck disable=SC2086
set -- ${original}
[ "$*" = "${original}" ] || deny

if [ "$#" -eq 5 ] \
  && [ "$1" = sudo ] \
  && [ "$2" = "${ACCOUNT_SCRIPT}" ] \
  && [ "$3" = issue ] \
  && is_credential_id "$4" \
  && is_unix_time "$5"; then
  password=
  IFS= read -r password || deny
  extra=
  if IFS= read -r extra || [ -n "${extra}" ]; then
    deny
  fi
  is_password "${password}" || deny
  printf '%s\n' "${password}" \
    | /usr/bin/sudo -- "${ACCOUNT_SCRIPT}" issue "$4" "$5"
  exit $?
fi

if [ "$#" -eq 4 ] \
  && [ "$1" = sudo ] \
  && [ "$2" = "${ACCOUNT_SCRIPT}" ] \
  && [ "$3" = revoke ] \
  && is_credential_id "$4"; then
  exec /usr/bin/sudo -- "${ACCOUNT_SCRIPT}" revoke "$4"
fi

deny
