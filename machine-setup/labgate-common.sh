#!/usr/bin/env bash

# Shared lifecycle primitives for the LabGate guest account. Every caller that
# reads or changes credential state must hold LABGATE_LOCK_FILE through
# labgate_acquire_lock first.

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly LABGATE_CONFIG_DIRECTORY=/etc/labgate
readonly LABGATE_STATE_DIRECTORY=/var/lib/labgate
readonly LABGATE_RUNTIME_DIRECTORY=/run/labgate
readonly LABGATE_LOCK_DIRECTORY=/run/lock/labgate
readonly LABGATE_LOCK_FILE=${LABGATE_LOCK_DIRECTORY}/guest.lock
readonly LABGATE_PAM_SESSION_FILE=${LABGATE_RUNTIME_DIRECTORY}/pam-session
readonly LABGATE_STATE_FILE=${LABGATE_STATE_DIRECTORY}/credential-state
readonly LABGATE_RECOVERY_FILE=${LABGATE_STATE_DIRECTORY}/recovery-needed
readonly LABGATE_OUTBOX_DIRECTORY=${LABGATE_STATE_DIRECTORY}/outbox
readonly LABGATE_OUTBOX_SEQUENCE_FILE=${LABGATE_STATE_DIRECTORY}/outbox-sequence
readonly LABGATE_LEGACY_OUTBOX_MIGRATION_FILE=${LABGATE_STATE_DIRECTORY}/outbox-legacy-migration
readonly LABGATE_TOMBSTONE_DIRECTORY=${LABGATE_STATE_DIRECTORY}/tombstones
readonly LABGATE_OUTBOX_SEQUENCE_LOCK=${LABGATE_LOCK_DIRECTORY}/outbox-sequence.lock
readonly LABGATE_OUTBOX_WORKER_LOCK=${LABGATE_LOCK_DIRECTORY}/webhook-outbox.lock
readonly LABGATE_PASSWORD_LENGTH_FILE=${LABGATE_CONFIG_DIRECTORY}/password-length
readonly LABGATE_GUEST_HOME_MODE_FILE=${LABGATE_CONFIG_DIRECTORY}/guest-home-mode
readonly LABGATE_AUTH_FAILURE_BACKENDS_FILE=${LABGATE_CONFIG_DIRECTORY}/auth-failure-backends
readonly LABGATE_SSH_HOST_KEY_SHA256_FILE=${LABGATE_CONFIG_DIRECTORY}/ssh-host-key-sha256
readonly LABGATE_WEBHOOK_CURL_CONFIG=${LABGATE_CONFIG_DIRECTORY}/webhook-curl.conf
readonly LABGATE_API_URL_FILE=${LABGATE_CONFIG_DIRECTORY}/api-url
readonly LABGATE_SSH_HOST_PUBLIC_KEY=/etc/ssh/ssh_host_ed25519_key.pub
readonly LABGATE_GUEST_HOME=/home/guest
readonly LABGATE_GUEST_LINGER_FILE=/var/lib/systemd/linger/guest
readonly LABGATE_USER_RUNTIME_PARENT=/run/user
readonly LABGATE_ACTIVE_RECOVERY_GRACE_SECONDS=120
readonly LABGATE_MAX_PENDING_TTL_SECONDS=86400
readonly LABGATE_EXPIRY_CLOCK_SKEW_SECONDS=60
readonly LABGATE_OUTBOX_SEQUENCE_MAX=999999999999999999
readonly LABGATE_CREDENTIAL_ID_PATTERN='^[A-Za-z0-9_-]{20,64}$'
readonly LABGATE_PASSWORD_PATTERN='^[A-HJ-NP-Za-km-z2-9]{5,128}$'

LABGATE_CREDENTIAL_ID=
LABGATE_GUEST_HOME_MODE=
LABGATE_CREDENTIAL_EXPIRES_AT=
LABGATE_CREDENTIAL_STATE=
LABGATE_STATE_VERSION=
LABGATE_STATE_CHANGED_AT=
LABGATE_PAM_CREDENTIAL_ID=
LABGATE_PAM_CONTEXT_KEY=
LABGATE_OUTBOX_ENDPOINT=
LABGATE_OUTBOX_CREDENTIAL_ID=
LABGATE_OUTBOX_EVENT_STATE_VERSION=
LABGATE_OUTBOX_FILENAME_KIND=
LABGATE_OUTBOX_FILENAME_SEQUENCE=
LABGATE_LEGACY_OUTBOX_COUNT=0
LABGATE_VERSIONED_OUTBOX_COUNT=0
LABGATE_LEGACY_OUTBOX_MIGRATION_COUNT=0

labgate_log() {
  logger --tag labgate -- "$*" 2>/dev/null || true
}

labgate_require_root() {
  [[ ${EUID} -eq 0 ]] || {
    printf 'LabGate lifecycle scripts must run as root.\n' >&2
    return 1
  }
}

labgate_validate_credential_id() {
  [[ ${1:-} =~ ${LABGATE_CREDENTIAL_ID_PATTERN} ]]
}

labgate_validate_unix_time() {
  [[ ${1:-} =~ ^[0-9]{1,12}$ ]] && (( 10#${1} > 0 ))
}

labgate_validate_registration_secret() {
  local secret=${1:-}

  (( ${#secret} >= 20 && ${#secret} <= 256 )) \
    && [[ ${secret} =~ ^[A-Za-z0-9._~+/-]+={0,2}$ ]]
}

labgate_validate_guest_home_mode() {
  [[ ${1:-} == y || ${1:-} == n ]]
}

labgate_load_guest_home_mode() {
  local extra mode

  labgate_file_is_root_private "${LABGATE_GUEST_HOME_MODE_FILE}" || return 1
  {
    IFS= read -r mode || return 1
    if IFS= read -r extra; then
      return 1
    fi
  } <"${LABGATE_GUEST_HOME_MODE_FILE}"
  labgate_validate_guest_home_mode "${mode}" || return 1
  LABGATE_GUEST_HOME_MODE=${mode}
}

labgate_validate_api_origin() {
  local authority host label octet port value=${1:-}
  local -a labels octets

  (( ${#value} >= 8 && ${#value} <= 2048 )) || return 1
  case "${value}" in
    http://*) authority=${value#http://} ;;
    https://*) authority=${value#https://} ;;
    *) return 1 ;;
  esac
  [[ -n ${authority} && ${authority} != *[!A-Za-z0-9.:-]* ]] || return 1

  host=${authority}
  if [[ ${authority} == *:* ]]; then
    [[ ${authority} != *:*:* ]] || return 1
    host=${authority%:*}
    port=${authority##*:}
    [[ ${port} =~ ^[1-9][0-9]{0,4}$ ]] || return 1
    (( 10#${port} <= 65535 )) || return 1
  fi
  [[ -n ${host} && ${host} != .* && ${host} != *. && ${host} != *..* ]] || return 1

  if [[ ${host} =~ ^[0-9.]+$ ]]; then
    IFS=. read -r -a octets <<<"${host}"
    (( ${#octets[@]} == 4 )) || return 1
    for octet in "${octets[@]}"; do
      [[ ${octet} =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
      (( 10#${octet} <= 255 )) || return 1
    done
    return 0
  fi

  (( ${#host} <= 253 )) || return 1
  [[ ${host} == "${host,,}" ]] || return 1
  IFS=. read -r -a labels <<<"${host}"
  (( ${#labels[@]} > 0 )) || return 1
  for label in "${labels[@]}"; do
    (( ${#label} >= 1 && ${#label} <= 63 )) || return 1
    [[ ${label} =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || return 1
  done
}

labgate_state_version_for() {
  case "${1:-}" in
    pending) printf '1\n' ;;
    active) printf '2\n' ;;
    revoked) printf '3\n' ;;
    *) return 1 ;;
  esac
}

labgate_initialize_directories() {
  local metadata path

  for path in \
    "${LABGATE_STATE_DIRECTORY}" \
    "${LABGATE_RUNTIME_DIRECTORY}" \
    "${LABGATE_LOCK_DIRECTORY}" \
    "${LABGATE_OUTBOX_DIRECTORY}" \
    "${LABGATE_TOMBSTONE_DIRECTORY}"; do
    if [[ -e ${path} || -L ${path} ]]; then
      [[ -d ${path} && ! -L ${path} ]] || return 1
    fi
  done
  install -d -o root -g root -m 0700 \
    "${LABGATE_STATE_DIRECTORY}" \
    "${LABGATE_RUNTIME_DIRECTORY}" \
    "${LABGATE_LOCK_DIRECTORY}" \
    "${LABGATE_OUTBOX_DIRECTORY}" \
    "${LABGATE_TOMBSTONE_DIRECTORY}" || return 1
  for path in \
    "${LABGATE_STATE_DIRECTORY}" \
    "${LABGATE_RUNTIME_DIRECTORY}" \
    "${LABGATE_LOCK_DIRECTORY}" \
    "${LABGATE_OUTBOX_DIRECTORY}" \
    "${LABGATE_TOMBSTONE_DIRECTORY}"; do
    [[ -d ${path} && ! -L ${path} ]] || return 1
    metadata=$(stat -c '%u:%g:%a' -- "${path}") || return 1
    [[ ${metadata} == 0:0:700 ]] || return 1
  done
}

labgate_acquire_lock() {
  labgate_initialize_directories || return 1
  exec 9>"${LABGATE_LOCK_FILE}" || return 1
  chmod 0600 "${LABGATE_LOCK_FILE}" || return 1
  flock -x 9
}

labgate_file_is_root_controlled() {
  local mode owner path=${1:-}

  [[ -f ${path} && ! -L ${path} ]] || return 1
  owner=$(stat -c '%u' -- "${path}") || return 1
  mode=$(stat -c '%a' -- "${path}") || return 1
  [[ ${owner} == 0 && ${mode} =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#${mode} & 8#022) == 0 ))
}

labgate_file_is_root_private() {
  local metadata path=${1:-}

  [[ -f ${path} && ! -L ${path} ]] || return 1
  metadata=$(stat -c '%u:%g:%a' -- "${path}") || return 1
  [[ ${metadata} == 0:0:600 ]]
}

labgate_prepare_private_lock_file() {
  local lock_file=${1:-}

  [[ ${lock_file} == "${LABGATE_LOCK_DIRECTORY}/"* ]] || return 1
  labgate_initialize_directories || return 1
  if [[ -e ${lock_file} || -L ${lock_file} ]]; then
    labgate_file_is_root_private "${lock_file}" || return 1
    return 0
  fi
  (umask 077; : >"${lock_file}") || return 1
  chown root:root "${lock_file}" || return 1
  chmod 0600 "${lock_file}" || return 1
  labgate_file_is_root_private "${lock_file}"
}

# Return values: 0 = terminal generation recorded, 1 = not recorded,
# 2 = a tombstone exists but is corrupt or unsafe.
labgate_generation_is_tombstoned() {
  local credential_id=${1:-} extra timestamp tombstone

  labgate_validate_credential_id "${credential_id}" || return 2
  tombstone=${LABGATE_TOMBSTONE_DIRECTORY}/${credential_id}
  [[ -e ${tombstone} ]] || return 1
  labgate_file_is_root_controlled "${tombstone}" || return 2
  {
    IFS= read -r timestamp || return 2
    if IFS= read -r extra; then
      return 2
    fi
  } <"${tombstone}"
  labgate_validate_unix_time "${timestamp}" || return 2
}

labgate_record_tombstone() {
  local credential_id=${1:-} now temporary tombstone tombstone_status=0

  labgate_validate_credential_id "${credential_id}" || return 1
  labgate_initialize_directories || return 1
  tombstone=${LABGATE_TOMBSTONE_DIRECTORY}/${credential_id}
  labgate_generation_is_tombstoned "${credential_id}" || tombstone_status=$?
  case "${tombstone_status}" in
    0) return 0 ;;
    1) ;;
    *) return 1 ;;
  esac
  now=$(date +%s) || return 1
  labgate_validate_unix_time "${now}" || return 1
  temporary=$(mktemp "${LABGATE_TOMBSTONE_DIRECTORY}/.tombstone.XXXXXX") || return 1
  chmod 0600 "${temporary}" || {
    rm -f -- "${temporary}"
    return 1
  }
  if ! printf '%s\n' "${now}" >"${temporary}" \
    || ! chown root:root "${temporary}" \
    || ! mv -f -- "${temporary}" "${tombstone}"; then
    rm -f -- "${temporary}"
    return 1
  fi
}

# Return values: 0 = valid state loaded, 2 = no state, 1 = corrupt/unsafe state.
labgate_load_state() {
  local extra line

  LABGATE_CREDENTIAL_ID=
  LABGATE_CREDENTIAL_EXPIRES_AT=
  LABGATE_CREDENTIAL_STATE=
  LABGATE_STATE_VERSION=
  LABGATE_STATE_CHANGED_AT=

  [[ -e ${LABGATE_STATE_FILE} ]] || return 2
  labgate_file_is_root_controlled "${LABGATE_STATE_FILE}" || return 1

  line=
  extra=
  {
    IFS= read -r line || [[ -n ${line} ]] || return 1
    if IFS= read -r extra; then
      return 1
    fi
  } <"${LABGATE_STATE_FILE}"

  IFS=$'\t' read -r \
    LABGATE_CREDENTIAL_ID \
    LABGATE_CREDENTIAL_EXPIRES_AT \
    LABGATE_CREDENTIAL_STATE \
    LABGATE_STATE_VERSION \
    LABGATE_STATE_CHANGED_AT \
    extra <<<"${line}"

  [[ -z ${extra} ]] || return 1
  labgate_validate_credential_id "${LABGATE_CREDENTIAL_ID}" || return 1
  labgate_validate_unix_time "${LABGATE_CREDENTIAL_EXPIRES_AT}" || return 1
  [[ ${LABGATE_CREDENTIAL_STATE} =~ ^(pending|active|revoked)$ ]] || return 1
  [[ ${LABGATE_STATE_VERSION} =~ ^[123]$ ]] || return 1
  [[ ${LABGATE_STATE_VERSION} == "$(labgate_state_version_for "${LABGATE_CREDENTIAL_STATE}")" ]] || return 1
  labgate_validate_unix_time "${LABGATE_STATE_CHANGED_AT}" || return 1
}

labgate_write_state() {
  local changed_at credential_id=${1:-} existing_status=0 expires_at=${2:-} state=${3:-} temporary version

  labgate_validate_credential_id "${credential_id}" || return 1
  labgate_validate_unix_time "${expires_at}" || return 1
  [[ ${state} =~ ^(pending|active|revoked)$ ]] || return 1
  version=$(labgate_state_version_for "${state}") || return 1
  changed_at=$(date +%s) || return 1
  labgate_validate_unix_time "${changed_at}" || return 1
  labgate_initialize_directories || return 1

  # State versions are monotonic within one credential generation. A new
  # generation may start at pending only after the prior generation is revoked.
  labgate_load_state || existing_status=$?
  case "${existing_status}" in
    0)
      if [[ ${LABGATE_CREDENTIAL_ID} == "${credential_id}" ]]; then
        [[ ${LABGATE_CREDENTIAL_EXPIRES_AT} == "${expires_at}" ]] || return 1
        (( 10#${version} >= 10#${LABGATE_STATE_VERSION} )) || return 1
      else
        [[ ${LABGATE_CREDENTIAL_STATE} == revoked && ${state} == pending ]] || return 1
      fi
      ;;
    2)
      [[ ${state} == pending ]] || return 1
      ;;
    *)
      return 1
      ;;
  esac

  if (( existing_status == 0 )) && [[ ${LABGATE_CREDENTIAL_STATE} == revoked ]]; then
    labgate_record_tombstone "${LABGATE_CREDENTIAL_ID}" || return 1
  fi
  if [[ ${state} == revoked ]]; then
    labgate_record_tombstone "${credential_id}" || return 1
  fi

  temporary=$(mktemp "${LABGATE_STATE_DIRECTORY}/.credential-state.XXXXXX") || return 1
  chmod 0600 "${temporary}" || {
    rm -f -- "${temporary}"
    return 1
  }
  if ! printf '%s\t%s\t%s\t%s\t%s\n' \
    "${credential_id}" "${expires_at}" "${state}" "${version}" "${changed_at}" >"${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  if ! chown root:root "${temporary}" || ! mv -f -- "${temporary}" "${LABGATE_STATE_FILE}"; then
    rm -f -- "${temporary}"
    return 1
  fi

  LABGATE_CREDENTIAL_ID=${credential_id}
  LABGATE_CREDENTIAL_EXPIRES_AT=${expires_at}
  LABGATE_CREDENTIAL_STATE=${state}
  LABGATE_STATE_VERSION=${version}
  LABGATE_STATE_CHANGED_AT=${changed_at}
}

# Record a generation as terminal when issuance failed before it could create
# pending state. This is allowed only with no state or after a different
# generation is already revoked; it can never replace pending/active work.
labgate_write_terminal_tombstone() {
  local changed_at credential_id=${1:-} existing_status=0 temporary

  labgate_validate_credential_id "${credential_id}" || return 1
  changed_at=$(date +%s) || return 1
  labgate_validate_unix_time "${changed_at}" || return 1
  labgate_initialize_directories || return 1

  labgate_load_state || existing_status=$?
  case "${existing_status}" in
    0)
      [[ ${LABGATE_CREDENTIAL_ID} != "${credential_id}" \
        && ${LABGATE_CREDENTIAL_STATE} == revoked ]] || return 1
      ;;
    2)
      ;;
    *)
      return 1
      ;;
  esac

  if (( existing_status == 0 )); then
    labgate_record_tombstone "${LABGATE_CREDENTIAL_ID}" || return 1
  fi
  labgate_record_tombstone "${credential_id}" || return 1

  temporary=$(mktemp "${LABGATE_STATE_DIRECTORY}/.credential-state.XXXXXX") || return 1
  chmod 0600 "${temporary}" || {
    rm -f -- "${temporary}"
    return 1
  }
  if ! printf '%s\t%s\trevoked\t3\t%s\n' \
    "${credential_id}" "${changed_at}" "${changed_at}" >"${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  if ! chown root:root "${temporary}" || ! mv -f -- "${temporary}" "${LABGATE_STATE_FILE}"; then
    rm -f -- "${temporary}"
    return 1
  fi

  LABGATE_CREDENTIAL_ID=${credential_id}
  LABGATE_CREDENTIAL_EXPIRES_AT=${changed_at}
  LABGATE_CREDENTIAL_STATE=revoked
  LABGATE_STATE_VERSION=3
  LABGATE_STATE_CHANGED_AT=${changed_at}
}

labgate_record_recovery() {
  local credential_id=${2:--} now reason=${1:-unknown} temporary

  [[ ${reason} =~ ^[A-Za-z0-9._:-]{1,96}$ ]] || reason=unknown
  if [[ ${credential_id} != - ]]; then
    labgate_validate_credential_id "${credential_id}" || credential_id=-
  fi
  now=$(date +%s) || now=0
  labgate_initialize_directories || return 1
  temporary=$(mktemp "${LABGATE_STATE_DIRECTORY}/.recovery-needed.XXXXXX") || return 1
  chmod 0600 "${temporary}" || {
    rm -f -- "${temporary}"
    return 1
  }
  if ! printf '%s\t%s\t%s\n' "${now}" "${credential_id}" "${reason}" >"${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  chown root:root "${temporary}" && mv -f -- "${temporary}" "${LABGATE_RECOVERY_FILE}"
}

labgate_clear_recovery() {
  rm -f -- "${LABGATE_RECOVERY_FILE}"
}

labgate_pam_context_key() {
  local context_key

  context_key=$(printf '%s\0%s\0%s\0%s\0%s\0' \
    "${PPID}" "${PAM_SERVICE:-}" "${PAM_TTY:-}" "${PAM_RHOST:-}" "${PAM_USER:-}" \
    | sha256sum \
    | awk '{ print $1 }') || return 1
  [[ ${context_key} =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s\n' "${context_key}"
}

labgate_write_pam_session() {
  local context_key=${2:-} credential_id=${1:-} temporary

  labgate_validate_credential_id "${credential_id}" || return 1
  [[ ${context_key} =~ ^[a-f0-9]{64}$ ]] || return 1
  labgate_initialize_directories || return 1
  temporary=$(mktemp "${LABGATE_RUNTIME_DIRECTORY}/.pam-session.XXXXXX") || return 1
  chmod 0600 "${temporary}" || {
    rm -f -- "${temporary}"
    return 1
  }
  if ! printf '%s\t%s\n' "${credential_id}" "${context_key}" >"${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  chown root:root "${temporary}" && mv -f -- "${temporary}" "${LABGATE_PAM_SESSION_FILE}"
}

# Return values: 0 = valid marker loaded, 2 = no marker, 1 = invalid marker.
labgate_load_pam_session() {
  local extra line trailing

  LABGATE_PAM_CREDENTIAL_ID=
  LABGATE_PAM_CONTEXT_KEY=
  [[ -e ${LABGATE_PAM_SESSION_FILE} ]] || return 2
  labgate_file_is_root_controlled "${LABGATE_PAM_SESSION_FILE}" || return 1
  exec 7<"${LABGATE_PAM_SESSION_FILE}" || return 1
  IFS= read -r line <&7 || {
    exec 7<&-
    return 1
  }
  if IFS= read -r trailing <&7; then
    exec 7<&-
    return 1
  fi
  exec 7<&-
  IFS=$'\t' read -r LABGATE_PAM_CREDENTIAL_ID LABGATE_PAM_CONTEXT_KEY extra <<<"${line}"
  [[ -z ${extra} ]] || return 1
  labgate_validate_credential_id "${LABGATE_PAM_CREDENTIAL_ID}" || return 1
  [[ ${LABGATE_PAM_CONTEXT_KEY} =~ ^[a-f0-9]{64}$ ]]
}

labgate_clear_pam_session() {
  rm -f -- "${LABGATE_PAM_SESSION_FILE}"
}

labgate_read_password_length() {
  local configured_length

  labgate_file_is_root_controlled "${LABGATE_PASSWORD_LENGTH_FILE}" || return 1
  IFS= read -r configured_length <"${LABGATE_PASSWORD_LENGTH_FILE}" || return 1
  [[ ${configured_length} =~ ^[0-9]{1,3}$ ]] || return 1
  (( 10#${configured_length} >= 5 && 10#${configured_length} <= 128 )) || return 1
  printf '%s\n' "${configured_length}"
}

labgate_validate_ssh_host_key_sha256() {
  [[ ${1:-} =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]]
}

labgate_compute_ssh_host_key_sha256() {
  local fingerprint output

  labgate_file_is_root_controlled "${LABGATE_SSH_HOST_PUBLIC_KEY}" || return 1
  output=$(ssh-keygen -lf "${LABGATE_SSH_HOST_PUBLIC_KEY}" -E sha256 2>/dev/null) \
    || return 1
  [[ ${output} != *$'\n'* ]] || return 1
  [[ ${output} =~ ^256[[:space:]]+(SHA256:[A-Za-z0-9+/]{43})[[:space:]].*[[:space:]]\(ED25519\)$ ]] \
    || return 1
  fingerprint=${BASH_REMATCH[1]}
  labgate_validate_ssh_host_key_sha256 "${fingerprint}" || return 1
  printf '%s\n' "${fingerprint}"
}

labgate_read_persisted_ssh_host_key_sha256() {
  local extra fingerprint

  labgate_file_is_root_private "${LABGATE_SSH_HOST_KEY_SHA256_FILE}" || return 1
  {
    IFS= read -r fingerprint || return 1
    if IFS= read -r extra; then
      return 1
    fi
  } <"${LABGATE_SSH_HOST_KEY_SHA256_FILE}"
  labgate_validate_ssh_host_key_sha256 "${fingerprint}" || return 1
  printf '%s\n' "${fingerprint}"
}

labgate_read_auth_failure_backends() {
  local backends extra

  labgate_file_is_root_controlled "${LABGATE_AUTH_FAILURE_BACKENDS_FILE}" || return 1
  {
    IFS= read -r backends || return 1
    if IFS= read -r extra; then
      return 1
    fi
  } <"${LABGATE_AUTH_FAILURE_BACKENDS_FILE}"
  case "${backends}" in
    none|faillock|pam_tally2|pam_tally|faillock,pam_tally2|faillock,pam_tally|pam_tally2,pam_tally|faillock,pam_tally2,pam_tally)
      printf '%s\n' "${backends}"
      ;;
    *) return 1 ;;
  esac
}

labgate_reset_guest_auth_failure_counters() {
  local backend backends

  backends=$(labgate_read_auth_failure_backends) || return 1
  [[ ${backends} != none ]] || return 0
  while IFS= read -r backend; do
    case "${backend}" in
      faillock)
        faillock --user guest --reset >/dev/null 2>&1 || return 1
        ;;
      pam_tally2)
        pam_tally2 --user guest --reset >/dev/null 2>&1 || return 1
        ;;
      pam_tally)
        pam_tally --user guest --reset >/dev/null 2>&1 || return 1
        ;;
      *) return 1 ;;
    esac
  done < <(tr ',' '\n' <<<"${backends}")
}

labgate_guest_account_aging_is_nonexpiring() {
  local account expire extra inactive last_change maximum minimum password record reserved warning

  record=$(getent shadow guest) || return 1
  IFS=: read -r \
    account password last_change minimum maximum warning inactive expire reserved extra \
    <<<"${record}"
  [[ ${account} == guest \
    && ( -z ${last_change} || ${last_change} =~ ^[0-9]+$ ) \
    && ${minimum} == 0 \
    && -z ${maximum} \
    && ${warning} == 0 \
    && -z ${inactive} \
    && -z ${expire} \
    && -z ${extra:-} ]]
}

labgate_prepare_guest_login_authentication() {
  chage --mindays 0 --maxdays -1 --warndays 0 \
    --inactive -1 --expiredate -1 guest >/dev/null 2>&1 || return 1
  labgate_guest_account_aging_is_nonexpiring || return 1
  labgate_reset_guest_auth_failure_counters
}

labgate_guest_is_locked() {
  local account status

  read -r account status _ < <(passwd -S guest 2>/dev/null) || return 2
  [[ ${account} == guest ]] || return 2
  case "${status}" in
    L|LK) return 0 ;;
    P|PS) return 1 ;;
    *) return 2 ;;
  esac
}

labgate_lock_guest() {
  passwd -l guest >/dev/null 2>&1 || return 1
  labgate_guest_is_locked
}

labgate_disable_guest_linger() {
  # loginctl is advisory here: remove and verify the marker ourselves even when
  # logind is unavailable. A persistent user manager would outlive PAM close and
  # could retain guest-owned processes after the physical desktop is gone.
  timeout --signal=KILL 5 loginctl disable-linger guest >/dev/null 2>&1 || true
  rm -f -- "${LABGATE_GUEST_LINGER_FILE}" || return 1
  [[ ! -e ${LABGATE_GUEST_LINGER_FILE} && ! -L ${LABGATE_GUEST_LINGER_FILE} ]]
}

# Return values: 0 = at least one logind session, 1 = no session, 2 = unknown.
labgate_guest_session_status() {
  local guest_uid output session uid remainder

  guest_uid=$(id -u guest) || return 2
  output=$(loginctl list-sessions --no-legend --no-pager 2>/dev/null) || return 2
  while read -r session uid remainder; do
    [[ -n ${session} ]] || continue
    if [[ ${uid} == "${guest_uid}" ]]; then
      return 0
    fi
  done <<<"${output}"
  return 1
}

# Return values: 0 = no real/effective-UID process, 1 = a process exists,
# 2 = process inventory failed.
labgate_guest_processes_absent() {
  local guest_uid status

  guest_uid=$(id -u guest) || return 2
  pgrep -u "${guest_uid}" >/dev/null 2>&1
  status=$?
  case "${status}" in
    0) return 1 ;;
    1) ;;
    *) return 2 ;;
  esac
  pgrep -U "${guest_uid}" >/dev/null 2>&1
  status=$?
  case "${status}" in
    0) return 1 ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
}

labgate_kill_guest_processes() {
  local attempt guest_uid

  guest_uid=$(id -u guest) || return 1
  timeout --signal=KILL 5 loginctl terminate-user guest >/dev/null 2>&1 || true
  pkill -TERM -u "${guest_uid}" >/dev/null 2>&1 || true
  pkill -TERM -U "${guest_uid}" >/dev/null 2>&1 || true
  for attempt in {1..20}; do
    if labgate_guest_processes_absent; then
      return 0
    fi
    sleep 0.1
  done
  pkill -KILL -u "${guest_uid}" >/dev/null 2>&1 || true
  pkill -KILL -U "${guest_uid}" >/dev/null 2>&1 || true
  for attempt in {1..20}; do
    if labgate_guest_processes_absent; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

labgate_clear_guest_scratch() {
  local guest_uid remaining scratch_directory

  labgate_guest_processes_absent || return 1
  guest_uid=$(id -u guest) || return 1
  for scratch_directory in /tmp /var/tmp /dev/shm; do
    [[ -d ${scratch_directory} && ! -L ${scratch_directory} ]] || return 1
    find "${scratch_directory}" -xdev -depth -mindepth 1 \
      -uid "${guest_uid}" -delete || return 1
    remaining=$(find "${scratch_directory}" -xdev -mindepth 1 \
      -uid "${guest_uid}" -print -quit) || return 1
    [[ -z ${remaining} ]] || return 1
  done
}

labgate_remove_guest_runtime_directory() {
  local guest_uid metadata runtime_directory

  labgate_guest_processes_absent || return 1
  [[ -d /run && ! -L /run ]] || return 1
  metadata=$(stat -c '%u:%g:%a' -- /run) || return 1
  [[ ${metadata} =~ ^0:0:[0-7]{3,4}$ ]] || return 1
  (( (8#${metadata##*:} & 8#022) == 0 )) || return 1
  if [[ ! -e ${LABGATE_USER_RUNTIME_PARENT} && ! -L ${LABGATE_USER_RUNTIME_PARENT} ]]; then
    install -d -o root -g root -m 0755 "${LABGATE_USER_RUNTIME_PARENT}" || return 1
  fi
  [[ -d ${LABGATE_USER_RUNTIME_PARENT} && ! -L ${LABGATE_USER_RUNTIME_PARENT} ]] || return 1
  metadata=$(stat -c '%u:%g:%a' -- "${LABGATE_USER_RUNTIME_PARENT}") || return 1
  [[ ${metadata} =~ ^0:0:[0-7]{3,4}$ ]] || return 1
  (( (8#${metadata##*:} & 8#022) == 0 )) || return 1

  guest_uid=$(id -u guest) || return 1
  [[ ${guest_uid} =~ ^[0-9]+$ ]] || return 1
  runtime_directory=${LABGATE_USER_RUNTIME_PARENT}/${guest_uid}
  if mountpoint --quiet "${runtime_directory}"; then
    umount "${runtime_directory}" || return 1
  fi
  mountpoint --quiet "${runtime_directory}" && return 1
  if [[ -e ${runtime_directory} || -L ${runtime_directory} ]]; then
    rm -rf --one-file-system -- "${runtime_directory}" || return 1
  fi
  [[ ! -e ${runtime_directory} && ! -L ${runtime_directory} ]]
}

labgate_create_fresh_guest_runtime_directory() {
  local guest_gid guest_uid metadata runtime_directory

  labgate_remove_guest_runtime_directory || return 1
  guest_uid=$(id -u guest) || return 1
  guest_gid=$(id -g guest) || return 1
  runtime_directory=${LABGATE_USER_RUNTIME_PARENT}/${guest_uid}
  install -d -o "${guest_uid}" -g "${guest_gid}" -m 0700 "${runtime_directory}" || return 1
  [[ -d ${runtime_directory} && ! -L ${runtime_directory} ]] || return 1
  metadata=$(stat -c '%u:%g:%a' -- "${runtime_directory}") || return 1
  [[ ${metadata} == "${guest_uid}:${guest_gid}:700" ]]
}

labgate_clear_guest_posix_mqueues() {
  local guest_uid remaining

  labgate_guest_processes_absent || return 1
  [[ -e /dev/mqueue || -L /dev/mqueue ]] || return 0
  [[ -d /dev/mqueue && ! -L /dev/mqueue ]] || return 1
  guest_uid=$(id -u guest) || return 1
  find /dev/mqueue -xdev -depth -mindepth 1 -uid "${guest_uid}" -delete || return 1
  remaining=$(find /dev/mqueue -xdev -mindepth 1 -uid "${guest_uid}" -print -quit) || return 1
  [[ -z ${remaining} ]]
}

labgate_clear_guest_sysv_ipc_type() {
  local guest_uid id ids inventory ipc_flag=${1:-} remaining

  case "${ipc_flag}" in q|m|s) ;; *) return 1 ;; esac
  guest_uid=$(id -u guest) || return 1
  inventory=$(ipcs "-${ipc_flag}" -c 2>/dev/null) || return 1
  ids=$(awk -v uid="${guest_uid}" '
    $1 ~ /^[0-9]+$/ && ($3 == "guest" || $5 == "guest" || $3 == uid || $5 == uid) {
      print $1
    }
  ' <<<"${inventory}") || return 1
  for id in ${ids}; do
    [[ ${id} =~ ^[0-9]+$ ]] || return 1
    ipcrm "-${ipc_flag}" "${id}" >/dev/null 2>&1 || return 1
  done
  inventory=$(ipcs "-${ipc_flag}" -c 2>/dev/null) || return 1
  remaining=$(awk -v uid="${guest_uid}" '
    $1 ~ /^[0-9]+$/ && ($3 == "guest" || $5 == "guest" || $3 == uid || $5 == uid) {
      print $1
      exit
    }
  ' <<<"${inventory}") || return 1
  [[ -z ${remaining} ]]
}

labgate_clear_guest_sysv_ipc() {
  local failed=0 ipc_flag

  labgate_guest_processes_absent || return 1
  for ipc_flag in q m s; do
    labgate_clear_guest_sysv_ipc_type "${ipc_flag}" || failed=1
  done
  return "${failed}"
}

labgate_clear_guest_persistent_keyring() {
  local guest_uid keyring list_output

  labgate_guest_processes_absent || return 1
  guest_uid=$(id -u guest) || return 1
  keyring=$(keyctl get_persistent @s "${guest_uid}" 2>/dev/null) || return 1
  [[ ${keyring} =~ ^[0-9]+$ ]] || return 1
  keyctl clear "${keyring}" >/dev/null 2>&1 || return 1
  list_output=$(keyctl list "${keyring}" 2>&1) || return 1
  [[ ${list_output} == 'keyring is empty' ]] || return 1
  keyctl unlink "${keyring}" @s >/dev/null 2>&1
}

labgate_clear_guest_mailboxes() {
  local canonical mailbox metadata parent

  labgate_guest_processes_absent || return 1
  for parent in /var/mail /var/spool/mail; do
    [[ -e ${parent} || -L ${parent} ]] || continue
    canonical=$(readlink -f -- "${parent}") || return 1
    case "${canonical}" in /var/mail|/var/spool/mail) ;; *) return 1 ;; esac
    [[ -d ${canonical} && ! -L ${canonical} ]] || return 1
    metadata=$(stat -c '%u:%a' -- "${canonical}") || return 1
    [[ ${metadata} =~ ^0:[0-7]{3,4}$ ]] || return 1
    if (( (8#${metadata##*:} & 8#002) != 0 )); then
      (( (8#${metadata##*:} & 8#1000) != 0 )) || return 1
    fi
    mailbox=${canonical}/guest
    if mountpoint --quiet "${mailbox}"; then
      umount "${mailbox}" || return 1
    fi
    mountpoint --quiet "${mailbox}" && return 1
    if [[ -e ${mailbox} || -L ${mailbox} ]]; then
      rm -rf --one-file-system -- "${mailbox}" || return 1
    fi
    [[ ! -e ${mailbox} && ! -L ${mailbox} ]] || return 1
  done
}

labgate_clear_guest_external_state() {
  local failed=0

  labgate_guest_processes_absent || return 1
  labgate_remove_guest_runtime_directory || failed=1
  labgate_clear_guest_posix_mqueues || failed=1
  labgate_clear_guest_sysv_ipc || failed=1
  labgate_clear_guest_persistent_keyring || failed=1
  labgate_clear_guest_mailboxes || failed=1
  return "${failed}"
}

labgate_prepare_dormant_home() {
  [[ ! -L ${LABGATE_GUEST_HOME} ]] || return 1
  mountpoint --quiet "${LABGATE_GUEST_HOME}" && return 1
  install -d -o root -g root -m 0700 "${LABGATE_GUEST_HOME}"
}

labgate_unmount_guest_home() {
  if mountpoint --quiet "${LABGATE_GUEST_HOME}"; then
    umount "${LABGATE_GUEST_HOME}" || return 1
  fi
  mountpoint --quiet "${LABGATE_GUEST_HOME}" && return 1
  labgate_prepare_dormant_home
}

labgate_guest_home_mode_change_is_drained() {
  local session_status

  labgate_guest_is_locked || return 1
  session_status=0
  labgate_guest_session_status >/dev/null 2>&1 || session_status=$?
  (( session_status == 1 )) || return 1
  labgate_guest_processes_absent || return 1
  ! mountpoint --quiet "${LABGATE_GUEST_HOME}" || return 1
  [[ ! -e ${LABGATE_GUEST_LINGER_FILE} && ! -L ${LABGATE_GUEST_LINGER_FILE} ]]
}

labgate_mount_fresh_guest_home() {
  local filesystem guest_gid guest_uid

  labgate_load_guest_home_mode || return 1
  guest_uid=$(id -u guest) || return 1
  guest_gid=$(id -g guest) || return 1
  labgate_clear_guest_external_state || return 1
  labgate_clear_guest_scratch || return 1
  labgate_unmount_guest_home || return 1
  if [[ ${LABGATE_GUEST_HOME_MODE} == y ]]; then
    labgate_create_fresh_guest_runtime_directory
    return
  fi
  mount --types tmpfs \
    --options "uid=${guest_uid},gid=${guest_gid},mode=0700,size=512M,nosuid,nodev" \
    tmpfs "${LABGATE_GUEST_HOME}" || return 1
  mountpoint --quiet "${LABGATE_GUEST_HOME}" || return 1
  filesystem=$(findmnt -n -o FSTYPE --target "${LABGATE_GUEST_HOME}") || return 1
  [[ ${filesystem} == tmpfs ]] || return 1
  labgate_create_fresh_guest_runtime_directory
}

# Try every local safety action even if an earlier one fails.
labgate_secure_guest() {
  local failed=0

  labgate_lock_guest || failed=1
  labgate_disable_guest_linger || failed=1
  labgate_kill_guest_processes || failed=1
  labgate_clear_guest_external_state || failed=1
  labgate_clear_guest_scratch || failed=1
  labgate_unmount_guest_home || failed=1
  return "${failed}"
}

labgate_validate_outbox_filename() {
  local filename path=${1:-} sequence

  LABGATE_OUTBOX_FILENAME_KIND=
  LABGATE_OUTBOX_FILENAME_SEQUENCE=
  filename=${path##*/}
  [[ ${path} == "${LABGATE_OUTBOX_DIRECTORY}/${filename}" ]] || return 1

  if [[ ${filename} =~ ^event-v2-([0-9]{18})$ ]]; then
    sequence=${BASH_REMATCH[1]}
    (( 10#${sequence} > 0 && 10#${sequence} <= LABGATE_OUTBOX_SEQUENCE_MAX )) || return 1
    LABGATE_OUTBOX_FILENAME_KIND=versioned
    LABGATE_OUTBOX_FILENAME_SEQUENCE=${sequence}
    return 0
  fi
  if [[ ${filename} =~ ^event-[0-9]+-[0-9]+-[A-Za-z0-9]{6}$ ]]; then
    LABGATE_OUTBOX_FILENAME_KIND=legacy
    return 0
  fi
  return 1
}

labgate_read_outbox_event_file() {
  local credential_id endpoint event_file=${1:-} extra line state_version trailing

  LABGATE_OUTBOX_ENDPOINT=
  LABGATE_OUTBOX_CREDENTIAL_ID=
  LABGATE_OUTBOX_EVENT_STATE_VERSION=
  labgate_file_is_root_private "${event_file}" || return 1
  {
    IFS= read -r line || return 1
    if IFS= read -r trailing; then
      return 1
    fi
  } <"${event_file}"

  IFS=$'\t' read -r endpoint credential_id state_version extra <<<"${line}"
  [[ -z ${extra} \
    && ${line} == "${endpoint}"$'\t'"${credential_id}"$'\t'"${state_version}" ]] || return 1
  case "${endpoint}" in
    session-open)
      [[ ${state_version} == 2 ]] || return 1
      ;;
    session-close|credential-expired)
      [[ ${state_version} == 3 ]] || return 1
      ;;
    *) return 1 ;;
  esac
  labgate_validate_credential_id "${credential_id}" || return 1

  LABGATE_OUTBOX_ENDPOINT=${endpoint}
  LABGATE_OUTBOX_CREDENTIAL_ID=${credential_id}
  LABGATE_OUTBOX_EVENT_STATE_VERSION=${state_version}
}

labgate_read_outbox_sequence() {
  local extra sequence trailing

  [[ -e ${LABGATE_OUTBOX_SEQUENCE_FILE} || -L ${LABGATE_OUTBOX_SEQUENCE_FILE} ]] || {
    printf '0\n'
    return 0
  }
  labgate_file_is_root_private "${LABGATE_OUTBOX_SEQUENCE_FILE}" || return 1
  {
    IFS= read -r sequence || return 1
    if IFS= read -r trailing; then
      return 1
    fi
  } <"${LABGATE_OUTBOX_SEQUENCE_FILE}"
  [[ ${sequence} =~ ^(0|[1-9][0-9]{0,17})$ ]] || return 1
  (( 10#${sequence} <= LABGATE_OUTBOX_SEQUENCE_MAX )) || return 1
  printf '%s\n' "${sequence}"
}

labgate_write_outbox_sequence() {
  local sequence=${1:-} temporary

  [[ ${sequence} =~ ^[1-9][0-9]{0,17}$ ]] || return 1
  (( 10#${sequence} <= LABGATE_OUTBOX_SEQUENCE_MAX )) || return 1
  temporary=$(mktemp "${LABGATE_STATE_DIRECTORY}/.outbox-sequence.XXXXXX") || return 1
  chmod 0600 "${temporary}" || {
    rm -f -- "${temporary}"
    return 1
  }
  if ! printf '%s\n' "${sequence}" >"${temporary}" \
    || ! chown root:root "${temporary}" \
    || ! sync -f "${temporary}" \
    || ! mv -f -- "${temporary}" "${LABGATE_OUTBOX_SEQUENCE_FILE}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  sync -f "${LABGATE_STATE_DIRECTORY}" || return 1
  labgate_file_is_root_private "${LABGATE_OUTBOX_SEQUENCE_FILE}"
}

labgate_inventory_legacy_outbox_migration() {
  local credential_id
  declare -A seen=()

  LABGATE_LEGACY_OUTBOX_MIGRATION_COUNT=0
  [[ -e ${LABGATE_LEGACY_OUTBOX_MIGRATION_FILE} \
    || -L ${LABGATE_LEGACY_OUTBOX_MIGRATION_FILE} ]] || return 0
  labgate_file_is_root_private "${LABGATE_LEGACY_OUTBOX_MIGRATION_FILE}" || return 1
  while IFS= read -r credential_id || [[ -n ${credential_id} ]]; do
    labgate_validate_credential_id "${credential_id}" || return 1
    [[ -z ${seen[${credential_id}]+present} ]] || return 1
    seen[${credential_id}]=1
    LABGATE_LEGACY_OUTBOX_MIGRATION_COUNT=$((LABGATE_LEGACY_OUTBOX_MIGRATION_COUNT + 1))
  done <"${LABGATE_LEGACY_OUTBOX_MIGRATION_FILE}"
  (( LABGATE_LEGACY_OUTBOX_MIGRATION_COUNT > 0 ))
}

# Validate every active outbox entry before setup or a legacy migration. Unknown
# names, unsafe metadata, malformed payloads, and corrupt migration journals are
# recovery conditions and are deliberately left untouched.
labgate_inventory_outbox() {
  local event_file filename metadata sequence

  LABGATE_LEGACY_OUTBOX_COUNT=0
  LABGATE_VERSIONED_OUTBOX_COUNT=0
  labgate_initialize_directories || return 1
  [[ -d ${LABGATE_OUTBOX_DIRECTORY} && ! -L ${LABGATE_OUTBOX_DIRECTORY} ]] || return 1
  metadata=$(stat -c '%u:%g:%a' -- "${LABGATE_OUTBOX_DIRECTORY}") || return 1
  [[ ${metadata} == 0:0:700 ]] || return 1

  for event_file in \
    "${LABGATE_OUTBOX_DIRECTORY}"/* \
    "${LABGATE_OUTBOX_DIRECTORY}"/.[!.]* \
    "${LABGATE_OUTBOX_DIRECTORY}"/..?*; do
    [[ -e ${event_file} || -L ${event_file} ]] || continue
    filename=${event_file##*/}
    [[ ${filename} == event-* ]] || return 1
    labgate_validate_outbox_filename "${event_file}" || return 1
    labgate_read_outbox_event_file "${event_file}" || return 1
    case "${LABGATE_OUTBOX_FILENAME_KIND}" in
      legacy) LABGATE_LEGACY_OUTBOX_COUNT=$((LABGATE_LEGACY_OUTBOX_COUNT + 1)) ;;
      versioned) LABGATE_VERSIONED_OUTBOX_COUNT=$((LABGATE_VERSIONED_OUTBOX_COUNT + 1)) ;;
      *) return 1 ;;
    esac
  done

  sequence=$(labgate_read_outbox_sequence) || return 1
  [[ ${sequence} =~ ^(0|[1-9][0-9]{0,17})$ ]] || return 1
  labgate_inventory_legacy_outbox_migration
}

labgate_write_legacy_outbox_migration() {
  local credential_id temporary

  (( $# > 0 )) || return 1
  temporary=$(mktemp "${LABGATE_STATE_DIRECTORY}/.outbox-legacy-migration.XXXXXX") || return 1
  chmod 0600 "${temporary}" || {
    rm -f -- "${temporary}"
    return 1
  }
  for credential_id in "$@"; do
    labgate_validate_credential_id "${credential_id}" || {
      rm -f -- "${temporary}"
      return 1
    }
    printf '%s\n' "${credential_id}" >>"${temporary}" || {
      rm -f -- "${temporary}"
      return 1
    }
  done
  if ! chown root:root "${temporary}" \
    || ! sync -f "${temporary}" \
    || ! mv -f -- "${temporary}" "${LABGATE_LEGACY_OUTBOX_MIGRATION_FILE}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  sync -f "${LABGATE_STATE_DIRECTORY}" || return 1
  labgate_file_is_root_private "${LABGATE_LEGACY_OUTBOX_MIGRATION_FILE}"
}

labgate_guest_is_dormant() {
  local guest_uid status

  labgate_guest_is_locked || return 1
  if labgate_guest_session_status; then
    return 1
  else
    status=$?
    (( status == 1 )) || return 1
  fi
  guest_uid=$(id -u guest) || return 1
  if pgrep -u "${guest_uid}" >/dev/null 2>&1; then
    return 1
  else
    status=$?
    (( status == 1 )) || return 1
  fi
  if pgrep -U "${guest_uid}" >/dev/null 2>&1; then
    return 1
  else
    status=$?
    (( status == 1 )) || return 1
  fi
  if mountpoint --quiet "${LABGATE_GUEST_HOME}"; then
    return 1
  else
    status=$?
    (( status == 1 )) || return 1
  fi
}

labgate_queue_event() (
  local credential_id=${2:-} current_sequence endpoint=${1:-} event_file final
  local live_sequence next_sequence state_version=${3:-} temporary

  case "${endpoint}" in
    session-open)
      [[ ${state_version} == 2 ]] || return 1
      ;;
    session-close|credential-expired)
      [[ ${state_version} == 3 ]] || return 1
      ;;
    *) return 1 ;;
  esac
  labgate_validate_credential_id "${credential_id}" || return 1
  labgate_initialize_directories || return 1
  labgate_prepare_private_lock_file "${LABGATE_OUTBOX_SEQUENCE_LOCK}" || return 1
  exec 6<>"${LABGATE_OUTBOX_SEQUENCE_LOCK}" || return 1
  flock -x 6 || return 1

  current_sequence=$(labgate_read_outbox_sequence) || return 1
  for event_file in "${LABGATE_OUTBOX_DIRECTORY}"/event-v2-*; do
    [[ -e ${event_file} || -L ${event_file} ]] || continue
    labgate_validate_outbox_filename "${event_file}" || return 1
    [[ ${LABGATE_OUTBOX_FILENAME_KIND} == versioned ]] || return 1
    live_sequence=${LABGATE_OUTBOX_FILENAME_SEQUENCE}
    if (( 10#${live_sequence} > 10#${current_sequence} )); then
      current_sequence=$((10#${live_sequence}))
    fi
  done
  (( 10#${current_sequence} < LABGATE_OUTBOX_SEQUENCE_MAX )) || return 1
  next_sequence=$((10#${current_sequence} + 1))
  printf -v final '%s/event-v2-%018d' "${LABGATE_OUTBOX_DIRECTORY}" "${next_sequence}"
  [[ ! -e ${final} && ! -L ${final} ]] || return 1

  # Persist the allocation before publishing the event. A crash can leave a
  # harmless sequence gap, but can never reuse a lower sequence number.
  labgate_write_outbox_sequence "${next_sequence}" || return 1
  temporary=$(mktemp "${LABGATE_OUTBOX_DIRECTORY}/.event.XXXXXX") || return 1
  chmod 0600 "${temporary}" || {
    rm -f -- "${temporary}"
    return 1
  }
  if ! printf '%s\t%s\t%s\n' "${endpoint}" "${credential_id}" "${state_version}" >"${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  chown root:root "${temporary}" || {
    rm -f -- "${temporary}"
    return 1
  }
  sync -f "${temporary}" || {
    rm -f -- "${temporary}"
    return 1
  }
  mv -- "${temporary}" "${final}" || {
    rm -f -- "${temporary}"
    return 1
  }
  sync -f "${LABGATE_OUTBOX_DIRECTORY}" || return 1
  labgate_file_is_root_private "${final}"
)

# Compact a validated old clock-named queue into terminal version-3 reports.
# The caller must already hold LABGATE_LOCK_FILE and must have stopped the old
# flush timer. This function takes only the worker lock and the short sequence
# lock; it never performs network I/O.
labgate_migrate_legacy_outbox() (
  local archive credential_id event_file state_status=0
  local -a credential_ids=() legacy_files=()
  declare -A seen=()

  labgate_require_root || return 1
  labgate_initialize_directories || return 1
  labgate_prepare_private_lock_file "${LABGATE_OUTBOX_WORKER_LOCK}" || return 1
  exec 8<>"${LABGATE_OUTBOX_WORKER_LOCK}" || return 1
  flock -x 8 || return 1
  labgate_inventory_outbox || return 1
  if (( LABGATE_LEGACY_OUTBOX_COUNT == 0 \
    && LABGATE_LEGACY_OUTBOX_MIGRATION_COUNT == 0 )); then
    return 0
  fi

  if [[ -e ${LABGATE_LEGACY_OUTBOX_MIGRATION_FILE} ]]; then
    while IFS= read -r credential_id || [[ -n ${credential_id} ]]; do
      [[ -z ${seen[${credential_id}]+present} ]] || return 1
      seen[${credential_id}]=1
      credential_ids+=("${credential_id}")
    done <"${LABGATE_LEGACY_OUTBOX_MIGRATION_FILE}"
  fi
  for event_file in "${LABGATE_OUTBOX_DIRECTORY}"/event-[0-9]*; do
    [[ -e ${event_file} || -L ${event_file} ]] || continue
    labgate_validate_outbox_filename "${event_file}" || return 1
    [[ ${LABGATE_OUTBOX_FILENAME_KIND} == legacy ]] || return 1
    labgate_read_outbox_event_file "${event_file}" || return 1
    credential_id=${LABGATE_OUTBOX_CREDENTIAL_ID}
    legacy_files+=("${event_file}")
    if [[ -z ${seen[${credential_id}]+present} ]]; then
      seen[${credential_id}]=1
      credential_ids+=("${credential_id}")
    fi
  done

  labgate_load_state || state_status=$?
  case "${state_status}" in
    0)
      credential_id=${LABGATE_CREDENTIAL_ID}
      if [[ -z ${seen[${credential_id}]+present} ]]; then
        seen[${credential_id}]=1
        credential_ids+=("${credential_id}")
      fi
      ;;
    2) ;;
    *) return 1 ;;
  esac
  (( ${#credential_ids[@]} > 0 )) || return 0

  # Refuse to infer safety from lifecycle state alone. Migration is permitted
  # only after account, session, process, and mount observations all prove the
  # physical endpoint dormant.
  labgate_guest_is_dormant || return 1
  labgate_write_legacy_outbox_migration "${credential_ids[@]}" || return 1
  labgate_secure_guest || return 1
  labgate_clear_pam_session || return 1
  [[ ! -e ${LABGATE_PAM_SESSION_FILE} && ! -L ${LABGATE_PAM_SESSION_FILE} ]] || return 1
  labgate_guest_is_dormant || return 1

  if (( state_status == 0 )) && [[ ${LABGATE_CREDENTIAL_STATE} != revoked ]]; then
    labgate_write_state \
      "${LABGATE_CREDENTIAL_ID}" "${LABGATE_CREDENTIAL_EXPIRES_AT}" revoked || return 1
  fi
  for credential_id in "${credential_ids[@]}"; do
    labgate_record_tombstone "${credential_id}" || return 1
    labgate_queue_event session-close "${credential_id}" 3 || return 1
  done

  if (( ${#legacy_files[@]} > 0 )); then
    archive=$(mktemp -d "${LABGATE_STATE_DIRECTORY}/legacy-outbox-archive.XXXXXX") || return 1
    chown root:root "${archive}" || return 1
    chmod 0700 "${archive}" || return 1
    mv -- "${legacy_files[@]}" "${archive}/" || return 1
    labgate_log "legacy webhook outbox archived after terminal compaction: ${archive}"
  fi
  labgate_inventory_outbox || return 1
  (( LABGATE_LEGACY_OUTBOX_COUNT == 0 )) || return 1
  rm -f -- "${LABGATE_LEGACY_OUTBOX_MIGRATION_FILE}" || return 1
  sync -f "${LABGATE_STATE_DIRECTORY}" || return 1
  [[ ! -e ${LABGATE_LEGACY_OUTBOX_MIGRATION_FILE} \
    && ! -L ${LABGATE_LEGACY_OUTBOX_MIGRATION_FILE} ]]
)

labgate_post_json() {
  local api_url endpoint=${1:-} payload=${2:-}

  case "${endpoint}" in
    session-open|session-close|credential-expired|heartbeat) ;;
    *) return 1 ;;
  esac
  labgate_file_is_root_controlled "${LABGATE_API_URL_FILE}" || return 1
  labgate_file_is_root_controlled "${LABGATE_WEBHOOK_CURL_CONFIG}" || return 1
  IFS= read -r api_url <"${LABGATE_API_URL_FILE}" || return 1
  labgate_validate_api_origin "${api_url}" || return 1

  printf '%s' "${payload}" | curl \
    --config "${LABGATE_WEBHOOK_CURL_CONFIG}" \
    --fail --silent --show-error \
    --connect-timeout 1 --max-time 2 \
    --request POST \
    --data-binary @- \
    --output /dev/null \
    --url "${api_url%/}/api/webhook/${endpoint}"
}
