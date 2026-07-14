#!/usr/bin/env bash
set -euo pipefail

readonly COMMON_LIBRARY=/usr/local/lib/labgate/labgate-common.sh

die() {
  printf 'guest-account: %s\n' "$1" >&2
  exit 64
}

[[ -r ${COMMON_LIBRARY} ]] || die "missing lifecycle library"
# shellcheck source=labgate-common.sh
source "${COMMON_LIBRARY}"

labgate_require_root || die "must run as root"
getent passwd guest >/dev/null || die "guest account does not exist"

action=${1:-}
case "${action}" in
  issue)
    [[ $# -eq 3 ]] || die "usage: guest-account.sh issue <credential-id> <expires-at-unix>"
    credential_id=$2
    expires_at=$3
    password=
    IFS= read -r password || die "password must be supplied as one input line"
    extra_password_input=
    if IFS= read -r extra_password_input || [[ -n ${extra_password_input} ]]; then
      die "password input must contain exactly one line"
    fi

    labgate_validate_credential_id "${credential_id}" || die "invalid credential id"
    labgate_validate_unix_time "${expires_at}" || die "invalid expiry deadline"
    now=$(date +%s) || die "could not read the local clock"
    labgate_validate_unix_time "${now}" || die "local clock returned an invalid Unix time"
    (( 10#${expires_at} > 10#${now} )) || die "expiry deadline is not in the future"
    (( 10#${expires_at} <= 10#${now} \
      + LABGATE_MAX_PENDING_TTL_SECONDS \
      + LABGATE_EXPIRY_CLOCK_SKEW_SECONDS )) \
      || die "expiry deadline exceeds the maximum pending-login window"
    password_length=$(labgate_read_password_length) || die "invalid password-length configuration"
    [[ ${password} =~ ${LABGATE_PASSWORD_PATTERN} ]] || die "password contains unsupported characters"
    (( ${#password} == 10#${password_length} )) || die "password length does not match machine configuration"

    labgate_acquire_lock || die "could not acquire lifecycle lock"
    tombstone_status=0
    labgate_generation_is_tombstoned "${credential_id}" || tombstone_status=$?
    case "${tombstone_status}" in
      0) die "a revoked credential generation cannot be reissued" ;;
      1) ;;
      *)
        labgate_record_recovery corrupt-generation-tombstone "${credential_id}" || true
        die "credential generation tombstone is corrupt"
        ;;
    esac
    state_status=0
    labgate_load_state || state_status=$?
    case "${state_status}" in
      0)
        case "${LABGATE_CREDENTIAL_STATE}" in
          active)
            die "cannot issue while a guest session is active"
            ;;
          pending)
            [[ ${LABGATE_CREDENTIAL_ID} == "${credential_id}" ]] || die "another credential is pending"
            [[ ${LABGATE_CREDENTIAL_EXPIRES_AT} == "${expires_at}" ]] || die "cannot change a pending credential deadline"
            ;;
          revoked)
            [[ ${LABGATE_CREDENTIAL_ID} != "${credential_id}" ]] || die "a revoked credential generation cannot be reissued"
            ;;
        esac
        ;;
      2)
        ;;
      *)
        labgate_record_recovery corrupt-state-during-issue "${credential_id}" || true
        die "credential state is corrupt"
        ;;
    esac

    session_status=0
    labgate_guest_session_status || session_status=$?
    case "${session_status}" in
      0) die "cannot issue while a guest login session exists" ;;
      1) ;;
      *) die "cannot verify that the guest has no login session" ;;
    esac

    labgate_secure_guest || {
      labgate_record_recovery issue-preparation-failed "${credential_id}" || true
      die "could not establish a clean locked guest account"
    }
    labgate_clear_pam_session
    labgate_write_state "${credential_id}" "${expires_at}" pending || {
      labgate_record_recovery issue-state-write-failed "${credential_id}" || true
      die "could not persist pending credential state"
    }

    if ! labgate_prepare_guest_login_authentication; then
      labgate_lock_guest || true
      labgate_record_recovery issue-authentication-reset-failed "${credential_id}" || true
      die "could not reset guest login aging and failure counters; guest remains locked"
    fi

    if ! printf 'guest:%s\n' "${password}" | chpasswd || ! passwd -u guest >/dev/null; then
      labgate_lock_guest || true
      labgate_record_recovery issue-password-rotation-failed "${credential_id}" || true
      die "password rotation failed; guest remains locked"
    fi
    if labgate_guest_is_locked; then
      labgate_record_recovery issue-unlock-verification-failed "${credential_id}" || true
      die "guest remained locked after password rotation"
    else
      lock_status=$?
      if (( lock_status != 1 )); then
        labgate_lock_guest || true
        labgate_record_recovery issue-unlock-status-unknown "${credential_id}" || true
        die "could not verify guest account unlock state"
      fi
    fi
    labgate_clear_recovery
    ;;

  revoke)
    [[ $# -eq 2 ]] || die "usage: guest-account.sh revoke <credential-id>"
    credential_id=$2
    labgate_validate_credential_id "${credential_id}" || die "invalid credential id"

    labgate_acquire_lock || die "could not acquire lifecycle lock"
    state_status=0
    labgate_load_state || state_status=$?
    revoke_mode=existing
    case "${state_status}" in
      0)
        if [[ ${LABGATE_CREDENTIAL_ID} == "${credential_id}" ]]; then
          [[ ${LABGATE_CREDENTIAL_STATE} != active ]] \
            || die "refusing to revoke an active guest session"
        elif [[ ${LABGATE_CREDENTIAL_STATE} == revoked ]]; then
          revoke_mode=tombstone
        else
          die "credential generation mismatch with pending or active state"
        fi
        ;;
      2)
        revoke_mode=tombstone
        ;;
      *)
        labgate_record_recovery corrupt-state-during-revoke "${credential_id}" || true
        die "credential state is corrupt"
        ;;
    esac

    session_status=0
    labgate_guest_session_status || session_status=$?
    case "${session_status}" in
      0) die "refusing to revoke while a guest login session exists" ;;
      1) ;;
      *) die "cannot verify that the guest has no login session" ;;
    esac

    labgate_secure_guest || {
      labgate_record_recovery revoke-local-safety-failed "${credential_id}" || true
      die "could not confirm local guest revocation"
    }
    labgate_clear_pam_session
    if [[ ${revoke_mode} == tombstone ]]; then
      labgate_write_terminal_tombstone "${credential_id}" || {
        labgate_record_recovery revoke-tombstone-write-failed "${credential_id}" || true
        die "guest is locked but terminal credential state could not be persisted"
      }
    elif [[ ${LABGATE_CREDENTIAL_STATE} != revoked ]]; then
      labgate_write_state "${credential_id}" "${LABGATE_CREDENTIAL_EXPIRES_AT}" revoked || {
        labgate_record_recovery revoke-state-write-failed "${credential_id}" || true
        die "guest is locked but revoked state could not be persisted"
      }
    fi
    labgate_clear_recovery
    ;;

  *)
    die "action must be issue or revoke"
    ;;
esac
