#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly PI_SCRIPT=${REPOSITORY_ROOT}/deploy/uninstall-pi.sh
readonly MACHINE_SCRIPT=${REPOSITORY_ROOT}/machine-setup/uninstall-machine.sh

fail() {
  printf 'uninstall script test failed: %s\n' "$1" >&2
  exit 1
}

[[ -x ${PI_SCRIPT} ]] || fail 'Pi uninstall script is not executable'
[[ -x ${MACHINE_SCRIPT} ]] || fail 'machine uninstall script is not executable'
bash -n "${MACHINE_SCRIPT}" || fail 'machine uninstall script has invalid Bash syntax'
sh -n "${PI_SCRIPT}" || fail 'Pi uninstall script has invalid POSIX shell syntax'

pi_prepare_output=$("${PI_SCRIPT}" prepare --dry-run)
[[ ${pi_prepare_output} == 'Would run: docker compose stop labgate' ]] \
  || fail 'Pi prepare dry-run is not exact'
pi_finalize_output=$("${PI_SCRIPT}" finalize --dry-run)
[[ ${pi_finalize_output} == 'Would run: docker compose down' ]] \
  || fail 'Pi finalize dry-run is not exact'

machine_output=$("${MACHINE_SCRIPT}" --dry-run)
grep -Fqx 'Would run local boot-lock recovery and verify guest safety.' \
  <<<"${machine_output}" \
  || fail 'machine dry-run does not include safety recovery'
grep -Fqx 'Would retain the guest passwd/chfn/chsh account-change guards.' \
  <<<"${machine_output}" \
  || fail 'machine dry-run does not include account-change guards'
grep -Fqx 'Would retain guest/provisioner accounts, SSH restrictions, boot lock, and LabGate state.' \
  <<<"${machine_output}" \
  || fail 'machine dry-run does not include retained protections'

if grep -Fq -- '--volumes' "${PI_SCRIPT}"; then
  fail 'Pi uninstall script can delete Compose volumes'
fi
if grep -En '(^|[^[:alnum:]_])(useradd|userdel|adduser|deluser)([^[:alnum:]_]|$)' \
  "${PI_SCRIPT}" "${MACHINE_SCRIPT}" >/dev/null; then
  fail 'uninstall scripts contain forbidden account lifecycle commands'
fi
grep -Fq "readonly PAM_OPEN_HOOK_LINE='session required pam_exec.so quiet type=open_session /usr/local/sbin/guest-session-hook.sh'" \
  "${MACHINE_SCRIPT}" \
  || fail 'machine uninstall does not recognize the open-session hook'
grep -Fq "readonly PAM_CLOSE_HOOK_LINE='session required pam_exec.so quiet type=close_session /usr/local/sbin/guest-session-hook.sh'" \
  "${MACHINE_SCRIPT}" \
  || fail 'machine uninstall does not recognize the close-session hook'
grep -Fq "readonly LEGACY_PAM_HOOK_NO_QUIET_LINE='session required pam_exec.so /usr/local/sbin/guest-session-hook.sh'" \
  "${MACHINE_SCRIPT}" \
  || fail 'machine uninstall does not recognize the old non-quiet hook'

printf 'uninstall script tests passed\n'
