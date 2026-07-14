#!/usr/bin/env bash
set -u

readonly COMMON_LIBRARY=/usr/local/lib/labgate/labgate-common.sh

[[ -r ${COMMON_LIBRARY} ]] || exit 1
# shellcheck source=labgate-common.sh
source "${COMMON_LIBRARY}"

labgate_require_root || exit 1
getent passwd guest >/dev/null || exit 1
labgate_acquire_lock || exit 1

cleanup_fail_secure() {
  local credential_id=${2:--} reason=$1

  labgate_secure_guest \
    || reason=${reason}-local-safety-failed
  labgate_clear_pam_session
  labgate_record_recovery "${reason}" "${credential_id}" || true
  return 1
}

state_status=0
labgate_load_state || state_status=$?
case "${state_status}" in
  2)
    # No generation is normal before first checkout, but it must still mean a
    # locked account, no shared-UID process, no tmpfs, and no PAM owner marker.
    labgate_secure_guest || exit 1
    labgate_clear_pam_session
    exit 0
    ;;
  0)
    ;;
  *)
    # Corrupt state cannot be interpreted as a safe active generation. Locking
    # is fail-safe, but the corrupt record is retained for operator recovery.
    labgate_secure_guest || true
    labgate_record_recovery cleanup-corrupt-state || true
    exit 1
    ;;
esac

credential_id=${LABGATE_CREDENTIAL_ID}
expires_at=${LABGATE_CREDENTIAL_EXPIRES_AT}
state=${LABGATE_CREDENTIAL_STATE}
changed_at=${LABGATE_STATE_CHANGED_AT}

case "${state}" in
  pending)
    now=
    if ! now=$(date +%s) || ! labgate_validate_unix_time "${now}"; then
      cleanup_fail_secure pending-clock-unavailable "${credential_id}" || true
      exit 1
    fi
    if (( 10#${now} < 10#${changed_at} )); then
      cleanup_fail_secure pending-clock-rollback "${credential_id}" || true
      exit 1
    fi
    (( 10#${now} >= 10#${expires_at} )) || exit 0
    if ! labgate_secure_guest; then
      labgate_record_recovery pending-expiry-local-safety-failed "${credential_id}" || true
      exit 1
    fi
    if ! labgate_write_state "${credential_id}" "${expires_at}" revoked; then
      labgate_record_recovery pending-expiry-state-write-failed "${credential_id}" || true
      exit 1
    fi
    labgate_clear_pam_session
    labgate_clear_recovery
    labgate_queue_event credential-expired "${credential_id}" 3 || \
      labgate_log "could not queue credential-expired for ${credential_id}"
    ;;

  active)
    session_status=0
    labgate_guest_session_status || session_status=$?
    case "${session_status}" in
      0)
        # There is intentionally no active-session TTL.
        exit 0
        ;;
      2)
        labgate_record_recovery cleanup-session-status-unknown "${credential_id}" || true
        exit 1
        ;;
    esac
    now=
    if ! now=$(date +%s) || ! labgate_validate_unix_time "${now}"; then
      cleanup_fail_secure stale-active-clock-unavailable "${credential_id}" || true
      exit 1
    fi
    if (( 10#${now} < 10#${changed_at} )); then
      cleanup_fail_secure stale-active-clock-rollback "${credential_id}" || true
      exit 1
    fi
    # Avoid racing the short interval between PAM open and logind publishing
    # the session. Beyond this grace, active-with-no-session is stale recovery.
    (( 10#${now} - 10#${changed_at} >= LABGATE_ACTIVE_RECOVERY_GRACE_SECONDS )) || exit 0
    if ! labgate_secure_guest; then
      labgate_record_recovery stale-active-local-safety-failed "${credential_id}" || true
      exit 1
    fi
    if ! labgate_write_state "${credential_id}" "${expires_at}" revoked; then
      labgate_record_recovery stale-active-state-write-failed "${credential_id}" || true
      exit 1
    fi
    labgate_clear_pam_session
    labgate_clear_recovery
    labgate_queue_event session-close "${credential_id}" 3 || \
      labgate_log "could not queue recovered session-close for ${credential_id}"
    ;;

  revoked)
    # Repair local drift without changing generations or emitting a new event.
    if ! labgate_secure_guest; then
      labgate_record_recovery revoked-state-local-safety-failed "${credential_id}" || true
      exit 1
    fi
    labgate_clear_pam_session
    labgate_clear_recovery
    ;;
esac

exit 0
