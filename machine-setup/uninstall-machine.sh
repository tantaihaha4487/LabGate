#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly COMMON_LIBRARY=/usr/local/lib/labgate/labgate-common.sh
readonly PAM_DIRECTORY=/etc/pam.d
readonly CONFIG_DIRECTORY=/etc/labgate
readonly BOOT_LOCK_SERVICE=guest-boot-lock.service
readonly PAM_HOOK_LINE='session required pam_exec.so quiet /usr/local/sbin/guest-session-hook.sh'
readonly LEGACY_PAM_HOOK_LINE='session required pam_exec.so /usr/local/sbin/guest-session-hook.sh'
readonly PAM_GUEST_ACCOUNT_CHANGE_AUTH_LINE='auth requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh'
readonly PAM_GUEST_ACCOUNT_CHANGE_PASSWORD_LINE='password requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh'
readonly TIMER_UNITS=(
  guest-cleanup.timer
  guest-heartbeat.timer
  guest-webhook-flush.timer
)
readonly SERVICE_UNITS=(
  guest-cleanup.service
  guest-heartbeat.service
  guest-webhook-flush.service
)

dry_run=0
confirmed=0

usage() {
  cat <<'EOF'
Usage: uninstall-machine.sh --confirm [--dry-run]

Decommission the LabGate integration on one already-drained physical endpoint.
The guest and provisioner accounts, SSH restrictions, boot lock, local state,
and identity files are retained.
EOF
}

die() {
  printf 'LabGate machine uninstall: %s\n' "$1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm)
      confirmed=1
      ;;
    --dry-run)
      dry_run=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if (( dry_run == 1 )); then
  printf '%s\n' \
    'Would run local boot-lock recovery and verify guest safety.' \
    'Would back up affected /etc/pam.d files under /root/labgate-uninstall-<timestamp>.' \
    'Would disable guest-cleanup.timer, guest-heartbeat.timer, and guest-webhook-flush.timer.' \
    'Would remove only the display-manager LabGate PAM session hook.' \
    'Would retain the guest passwd/chfn/chsh account-change guards.' \
    'Would retain guest/provisioner accounts, SSH restrictions, boot lock, and LabGate state.'
  exit 0
fi

(( confirmed == 1 )) || die 'refusing to change the endpoint without --confirm'
(( EUID == 0 )) || die 'must run as root'

for command in \
  awk cat chmod chown cp date find getent grep id install loginctl mktemp mountpoint mv \
  passwd pgrep rm sed stat systemctl; do
  command -v "${command}" >/dev/null 2>&1 \
    || die "required command not found: ${command}"
done

[[ -r ${COMMON_LIBRARY} ]] || die "missing common lifecycle library: ${COMMON_LIBRARY}"
# shellcheck source=labgate-common.sh
source "${COMMON_LIBRARY}"

getent passwd guest >/dev/null 2>&1 || die 'the shared guest account is missing'
[[ -x /usr/local/sbin/guest-boot-lock.sh ]] \
  || die 'the installed boot-lock script is missing'
[[ -f ${CONFIG_DIRECTORY}/pam-file && ! -L ${CONFIG_DIRECTORY}/pam-file ]] \
  || die 'the recorded display-manager PAM file is missing or unsafe'

read_pam_file() {
  local value extra

  {
    IFS= read -r value || die 'could not read the recorded display-manager PAM file'
    if IFS= read -r extra; then
      die 'the recorded display-manager PAM file contains extra data'
    fi
  } <"${CONFIG_DIRECTORY}/pam-file"
  [[ ${value} == "${PAM_DIRECTORY}/"* && ${value%/*} == ${PAM_DIRECTORY} \
    && -f ${value} && ! -L ${value} ]] \
    || die 'the recorded display-manager PAM file is outside /etc/pam.d or unsafe'
  printf '%s\n' "${value}"
}

recorded_pam_file=$(read_pam_file)

verify_guest_safe() {
  local session_status

  /usr/local/sbin/guest-boot-lock.sh \
    || die 'boot-lock recovery could not complete'
  labgate_guest_is_locked \
    || die 'guest is not locked after boot-lock recovery'

  session_status=0
  labgate_guest_session_status || session_status=$?
  case "${session_status}" in
    1) ;;
    0) die 'an active guest session remains' ;;
    *) die 'could not determine guest session state' ;;
  esac

  labgate_guest_processes_absent \
    || die 'guest-owned processes remain or process state is unknown'
  mountpoint --quiet /home/guest \
    && die '/home/guest is still mounted'
  [[ ! -e /run/labgate/pam-session && ! -L /run/labgate/pam-session ]] \
    || die 'the PAM session ownership marker remains'
  [[ ! -e /var/lib/labgate/recovery-needed \
    && ! -L /var/lib/labgate/recovery-needed ]] \
    || die 'local recovery state is still required'
}

managed_pam_files=()
add_managed_pam_file() {
  local candidate=$1 existing

  [[ -f ${candidate} && ! -L ${candidate} ]] \
    || die "managed PAM file is missing or unsafe: ${candidate}"
  for existing in "${managed_pam_files[@]}"; do
    [[ ${existing} != "${candidate}" ]] || return 0
  done
  managed_pam_files+=("${candidate}")
}

discover_pam_files() {
  local candidate

  add_managed_pam_file "${recorded_pam_file}"
  for candidate in \
    "${PAM_DIRECTORY}/chfn" \
    "${PAM_DIRECTORY}/chsh" \
    "${PAM_DIRECTORY}/passwd"; do
    add_managed_pam_file "${candidate}"
  done

  while IFS= read -r -d '' candidate; do
    if grep -Fqx "${PAM_HOOK_LINE}" "${candidate}" \
      || grep -Fqx "${LEGACY_PAM_HOOK_LINE}" "${candidate}"; then
      add_managed_pam_file "${candidate}"
    fi
  done < <(find "${PAM_DIRECTORY}" -xdev -type f -print0)
}

backup_pam_files() {
  local backup_directory candidate destination timestamp

  timestamp=$(date -u +%Y%m%d-%H%M%S) \
    || die 'could not create a PAM backup timestamp'
  backup_directory="/root/labgate-uninstall-${timestamp}"
  [[ ! -e ${backup_directory} && ! -L ${backup_directory} ]] \
    || die "PAM backup directory already exists: ${backup_directory}"
  install -d -o root -g root -m 0700 "${backup_directory}/etc/pam.d"
  for candidate in "${managed_pam_files[@]}"; do
    destination="${backup_directory}${candidate}"
    cp -a -- "${candidate}" "${destination}"
  done
  printf '%s\n' "${backup_directory}"
}

remove_lines() {
  local destination=$1
  shift
  local temporary

  [[ -f ${destination} && ! -L ${destination} ]] \
    || die "unsafe PAM file during rewrite: ${destination}"
  temporary=$(mktemp) || die "could not create a PAM rewrite temporary file"
  awk -v first="${1:-}" -v second="${2:-}" -v third="${3:-}" '
    (first == "" || $0 != first) &&
    (second == "" || $0 != second) &&
    (third == "" || $0 != third) { print }
  ' "${destination}" >"${temporary}" || {
    rm -f -- "${temporary}"
    die "could not rewrite PAM file: ${destination}"
  }
  chown --reference="${destination}" "${temporary}"
  chmod --reference="${destination}" "${temporary}"
  mv -f -- "${temporary}" "${destination}"
}

remove_pam_session_integration() {
  local candidate

  for candidate in "${managed_pam_files[@]}"; do
    remove_lines "${candidate}" \
      "${PAM_HOOK_LINE}" \
      "${LEGACY_PAM_HOOK_LINE}" \
      ''
  done
}

verify_pam_integration_removed() {
  local candidate

  while IFS= read -r -d '' candidate; do
    if grep -Fqx "${PAM_HOOK_LINE}" "${candidate}" \
      || grep -Fqx "${LEGACY_PAM_HOOK_LINE}" "${candidate}"; then
      die "LabGate PAM integration remains in ${candidate}"
    fi
  done < <(find "${PAM_DIRECTORY}" -xdev -type f -print0)
}

verify_guest_account_change_guards() {
  local count

  count=$(grep -Fxc "${PAM_GUEST_ACCOUNT_CHANGE_AUTH_LINE}" /etc/pam.d/chfn || true)
  [[ ${count} == 1 ]] || die 'guest chfn account-change guard is missing or duplicated'
  count=$(grep -Fxc "${PAM_GUEST_ACCOUNT_CHANGE_AUTH_LINE}" /etc/pam.d/chsh || true)
  [[ ${count} == 1 ]] || die 'guest chsh account-change guard is missing or duplicated'
  count=$(grep -Fxc "${PAM_GUEST_ACCOUNT_CHANGE_PASSWORD_LINE}" /etc/pam.d/passwd || true)
  [[ ${count} == 1 ]] || die 'guest passwd account-change guard is missing or duplicated'
}

disable_lifecycle_units() {
  local active_state enabled_state unit

  for unit in "${SERVICE_UNITS[@]}"; do
    systemctl stop "${unit}" >/dev/null 2>&1 || true
    active_state=$(systemctl is-active "${unit}" 2>/dev/null || true)
    case "${active_state}" in
      inactive|failed|unknown|not-found|'') ;;
      *) die "${unit} remains active" ;;
    esac
  done
  for unit in "${TIMER_UNITS[@]}"; do
    systemctl disable --now "${unit}" >/dev/null 2>&1 || true
    enabled_state=$(systemctl is-enabled "${unit}" 2>/dev/null || true)
    case "${enabled_state}" in
      disabled|masked|not-found|'') ;;
      *) die "${unit} remains enabled" ;;
    esac
    active_state=$(systemctl is-active "${unit}" 2>/dev/null || true)
    case "${active_state}" in
      inactive|failed|unknown|not-found|'') ;;
      *) die "${unit} remains active" ;;
    esac
  done
}

keep_boot_lock_enabled() {
  local enabled_state

  systemctl enable --now "${BOOT_LOCK_SERVICE}" >/dev/null 2>&1 \
    || die "could not keep ${BOOT_LOCK_SERVICE} enabled"
  enabled_state=$(systemctl is-enabled "${BOOT_LOCK_SERVICE}" 2>/dev/null || true)
  case "${enabled_state}" in
    enabled|enabled-runtime|static) ;;
    *) die "${BOOT_LOCK_SERVICE} is not enabled: ${enabled_state}" ;;
  esac
}

verify_guest_safe
discover_pam_files
backup_directory=$(backup_pam_files)
disable_lifecycle_units
remove_pam_session_integration
verify_pam_integration_removed
verify_guest_account_change_guards
keep_boot_lock_enabled
verify_guest_safe

printf 'LabGate integration removed safely. PAM backup: %s\n' "${backup_directory}"
printf 'Guest/provisioner accounts, SSH restrictions, boot lock, and local state were retained.\n'
