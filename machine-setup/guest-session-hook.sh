#!/usr/bin/env bash
set -u

readonly COMMON_LIBRARY=/usr/local/lib/labgate/labgate-common.sh

[[ ${PAM_USER:-} == guest ]] || exit 0
[[ -r ${COMMON_LIBRARY} ]] || exit 1
# shellcheck source=labgate-common.sh
source "${COMMON_LIBRARY}"

labgate_require_root || exit 1
getent passwd guest >/dev/null || exit 1
labgate_acquire_lock || exit 1

pam_open_fail_secure() {
  local credential_id=${2:--} reason=$1

  labgate_secure_guest \
    || reason=${reason}-local-safety-failed
  labgate_clear_pam_session
  labgate_record_recovery "${reason}" "${credential_id}" || true
  return 1
}

case "${PAM_TYPE:-}" in
  open_session)
    state_status=0
    labgate_load_state || state_status=$?
    if (( state_status != 0 )); then
      pam_open_fail_secure pam-open-state-unavailable || true
      exit 1
    fi
    if [[ ${LABGATE_CREDENTIAL_STATE} == active ]]; then
      # A second concurrent desktop login must not share an active generation.
      exit 1
    fi
    if [[ ${LABGATE_CREDENTIAL_STATE} != pending ]]; then
      labgate_secure_guest || true
      labgate_clear_pam_session
      exit 1
    fi

    credential_id=${LABGATE_CREDENTIAL_ID}
    expires_at=${LABGATE_CREDENTIAL_EXPIRES_AT}
    now=
    if ! now=$(date +%s) || ! labgate_validate_unix_time "${now}"; then
      pam_open_fail_secure pam-open-clock-unavailable "${credential_id}" || true
      exit 1
    fi
    if (( 10#${now} < 10#${LABGATE_STATE_CHANGED_AT} )); then
      pam_open_fail_secure pam-open-clock-rollback "${credential_id}" || true
      exit 1
    fi
    if (( 10#${now} >= 10#${expires_at} )); then
      if labgate_secure_guest \
        && labgate_write_state "${credential_id}" "${expires_at}" revoked; then
        labgate_clear_pam_session
        labgate_clear_recovery
        labgate_queue_event credential-expired "${credential_id}" 3 || \
          labgate_log "could not queue expired credential ${credential_id} from PAM open"
      else
        labgate_record_recovery pam-open-expired-safety-failed "${credential_id}" || true
      fi
      exit 1
    fi

    if labgate_guest_is_locked; then
      pam_open_fail_secure pam-open-account-locked "${credential_id}" || true
      exit 1
    else
      account_status=$?
      (( account_status == 1 )) || {
        pam_open_fail_secure pam-open-account-status-unknown "${credential_id}" || true
        exit 1
      }
    fi

    if ! labgate_kill_guest_processes || ! labgate_mount_fresh_guest_home; then
      labgate_secure_guest || true
      labgate_record_recovery pam-open-home-preparation-failed "${credential_id}" || true
      exit 1
    fi
    context_key=$(labgate_pam_context_key) || {
      labgate_secure_guest || true
      labgate_record_recovery pam-open-context-key-failed "${credential_id}" || true
      exit 1
    }
    if ! labgate_write_pam_session "${credential_id}" "${context_key}"; then
      labgate_secure_guest || true
      labgate_record_recovery pam-open-session-marker-failed "${credential_id}" || true
      exit 1
    fi
    if ! labgate_write_state "${credential_id}" "${expires_at}" active; then
      labgate_clear_pam_session
      if labgate_secure_guest \
        && labgate_write_state "${credential_id}" "${expires_at}" revoked; then
        labgate_queue_event session-close "${credential_id}" 3 || true
      else
        labgate_record_recovery pam-open-state-write-failed "${credential_id}" || true
      fi
      exit 1
    fi

    labgate_clear_recovery
    labgate_queue_event session-open "${credential_id}" 2 || \
      labgate_log "could not queue session-open for ${credential_id}"
    ;;

  close_session)
    context_key=
    context_status=0
    context_key=$(labgate_pam_context_key) || context_status=$?
    marker_status=0
    if (( context_status == 0 )); then
      labgate_load_pam_session || marker_status=$?
    else
      marker_status=1
    fi
    if (( marker_status == 0 )) && [[ ${LABGATE_PAM_CONTEXT_KEY} != "${context_key}" ]]; then
      # A failed concurrent open may be followed by close_session. It must not
      # revoke the generation owned by a different PAM transaction.
      labgate_log "ignored unmatched guest PAM close transaction"
      exit 0
    fi

    state_status=0
    labgate_load_state || state_status=$?
    credential_id=${LABGATE_CREDENTIAL_ID:-${LABGATE_PAM_CREDENTIAL_ID:--}}
    expires_at=${LABGATE_CREDENTIAL_EXPIRES_AT:-}
    previous_state=${LABGATE_CREDENTIAL_STATE:-}

    if (( context_status != 0 )); then
      labgate_record_recovery pam-close-context-key-unavailable "${credential_id}" || true
    elif (( marker_status != 0 )); then
      # A missing or corrupt owner marker is not a valid concurrent-session
      # signal. Fail toward local safety immediately instead of leaving the
      # shared password and tmpfs usable until timer recovery.
      labgate_record_recovery pam-close-owner-marker-unavailable "${credential_id}" || true
    elif (( state_status == 0 )) \
      && [[ ${LABGATE_CREDENTIAL_ID} != "${LABGATE_PAM_CREDENTIAL_ID}" ]]; then
      # State/marker disagreement is corruption. Secure the current generation
      # first; never return while a potentially reusable guest session remains.
      labgate_record_recovery pam-close-generation-mismatch "${credential_id}" || true
    fi

    # Account lock is deliberately the first local revocation action. Continue
    # with process termination and unmount even when one action fails.
    if ! labgate_secure_guest; then
      labgate_record_recovery pam-close-local-safety-failed "${credential_id:--}" || true
      exit 1
    fi
    if (( state_status != 0 )); then
      labgate_clear_pam_session
      labgate_record_recovery pam-close-state-unavailable "${credential_id}" || true
      exit 1
    fi
    if [[ ${LABGATE_CREDENTIAL_STATE} != revoked ]] \
      && ! labgate_write_state "${credential_id}" "${expires_at}" revoked; then
      labgate_record_recovery pam-close-state-write-failed "${credential_id}" || true
      exit 1
    fi

    labgate_clear_pam_session
    labgate_clear_recovery
    if [[ ${previous_state} != revoked || ${marker_status} == 0 ]]; then
      labgate_queue_event session-close "${credential_id}" 3 || \
        labgate_log "could not queue session-close for ${credential_id}"
    fi
    ;;
esac

exit 0
