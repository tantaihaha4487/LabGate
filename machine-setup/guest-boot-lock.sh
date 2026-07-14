#!/usr/bin/env bash
set -u

readonly COMMON_LIBRARY=/usr/local/lib/labgate/labgate-common.sh

[[ -r ${COMMON_LIBRARY} ]] || exit 1
# shellcheck source=labgate-common.sh
source "${COMMON_LIBRARY}"

labgate_require_root || exit 1
getent passwd guest >/dev/null || exit 1
labgate_acquire_lock || exit 1

state_status=0
labgate_load_state || state_status=$?
credential_id=${LABGATE_CREDENTIAL_ID:-}
expires_at=${LABGATE_CREDENTIAL_EXPIRES_AT:-}
previous_state=${LABGATE_CREDENTIAL_STATE:-}

# A reboot always invalidates local access, regardless of persisted state.
if ! labgate_secure_guest; then
  labgate_record_recovery boot-local-safety-failed "${credential_id:--}" || true
  labgate_log "boot lock could not confirm all guest safety actions; recovery state retained"
  exit 1
fi
labgate_clear_pam_session

case "${state_status}" in
  0)
    if [[ ${previous_state} != revoked ]]; then
      if ! labgate_write_state "${credential_id}" "${expires_at}" revoked; then
        labgate_record_recovery boot-state-write-failed "${credential_id}" || true
        labgate_log "boot lock secured guest but could not persist revoked state"
        exit 0
      fi
    elif ! labgate_record_tombstone "${credential_id}"; then
      labgate_record_recovery boot-tombstone-write-failed "${credential_id}" || true
      labgate_log "boot lock secured guest but could not persist the terminal generation tombstone"
      exit 0
    fi
    labgate_log "boot lock secured credential ${credential_id}; heartbeat will report revoked state"
    ;;
  2)
    labgate_log "boot lock secured guest with no credential generation"
    ;;
  *)
    labgate_record_recovery boot-corrupt-state || true
    labgate_log "boot lock secured guest; corrupt credential state retained for recovery"
    exit 0
    ;;
esac

labgate_clear_recovery
exit 0
