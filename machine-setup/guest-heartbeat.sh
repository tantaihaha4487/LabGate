#!/usr/bin/env bash
set -u

readonly COMMON_LIBRARY=/usr/local/lib/labgate/labgate-common.sh

[[ -r ${COMMON_LIBRARY} ]] || exit 0
# shellcheck source=labgate-common.sh
source "${COMMON_LIBRARY}"

labgate_require_root || exit 0
labgate_acquire_lock || exit 0

credential_json=null
state_json=null
state_version_json=null
session_active=false
guest_locked=false

state_status=0
labgate_load_state || state_status=$?
case "${state_status}" in
  0)
    credential_json=\"${LABGATE_CREDENTIAL_ID}\"
    state_json=\"${LABGATE_CREDENTIAL_STATE}\"
    state_version_json=${LABGATE_STATE_VERSION}
    ;;
  1)
    recovery_reason=heartbeat-corrupt-state
    if ! labgate_secure_guest; then
      recovery_reason=heartbeat-corrupt-state-safety-failed
    elif ! labgate_clear_pam_session; then
      recovery_reason=heartbeat-corrupt-state-pam-clear-failed
    fi
    labgate_record_recovery "${recovery_reason}" || true
    labgate_log "heartbeat secured but withheld corrupt credential state"
    flock -u 9 || true
    exit 0
    ;;
  2)
    # A null lifecycle snapshot can release a server safety hold, so it is a
    # proof-producing operation rather than passive observation. Establish the
    # complete local safety boundary under the lifecycle lock first.
    if ! labgate_secure_guest; then
      labgate_record_recovery heartbeat-no-state-safety-failed || true
      labgate_log "heartbeat withheld unsafe no-state snapshot"
      flock -u 9 || true
      exit 0
    fi
    if ! labgate_clear_pam_session; then
      labgate_record_recovery heartbeat-no-state-pam-clear-failed || true
      labgate_log "heartbeat withheld no-state snapshot with a persistent PAM marker"
      flock -u 9 || true
      exit 0
    fi
    ;;
  *)
    labgate_record_recovery heartbeat-state-status-invalid || true
    flock -u 9 || true
    exit 0
    ;;
esac

session_status=0
labgate_guest_session_status || session_status=$?
if (( session_status == 0 )); then
  session_active=true
elif (( session_status == 2 )) && [[ ${LABGATE_CREDENTIAL_STATE:-} == active ]]; then
  # Unknown is represented conservatively so a transient logind failure cannot
  # cause the server to release a machine with an active local generation.
  session_active=true
fi

if labgate_guest_is_locked; then
  guest_locked=true
fi

if [[ ${LABGATE_CREDENTIAL_STATE:-} == active && ${guest_locked} == true ]]; then
  labgate_record_recovery heartbeat-active-but-locked "${LABGATE_CREDENTIAL_ID}" || true
  labgate_log "heartbeat reports contradictory active and locked state for ${LABGATE_CREDENTIAL_ID}"
elif [[ ${LABGATE_CREDENTIAL_STATE:-} == revoked \
  && ( ${guest_locked} != true || ${session_active} == true ) ]]; then
  labgate_record_recovery heartbeat-revoked-but-unsafe "${LABGATE_CREDENTIAL_ID}" || true
  labgate_log "heartbeat reports contradictory revoked local state for ${LABGATE_CREDENTIAL_ID}"
fi

payload=$(printf \
  '{"credentialId":%s,"stateVersion":%s,"sessionActive":%s,"guestLocked":%s,"state":%s}' \
  "${credential_json}" "${state_version_json}" "${session_active}" "${guest_locked}" "${state_json}")
flock -u 9 || true

# Heartbeats are best effort. The timer will retry, and no local lifecycle
# decision depends on webhook availability.
labgate_post_json heartbeat "${payload}" >/dev/null 2>&1 || true
exit 0
