#!/usr/bin/env bash
set -u

readonly COMMON_LIBRARY=/usr/local/lib/labgate/labgate-common.sh

[[ -r ${COMMON_LIBRARY} ]] || exit 0
# shellcheck source=labgate-common.sh
source "${COMMON_LIBRARY}"

labgate_require_root || exit 0
labgate_initialize_directories || exit 0
labgate_prepare_private_lock_file "${LABGATE_OUTBOX_WORKER_LOCK}" || exit 0
exec 8<>"${LABGATE_OUTBOX_WORKER_LOCK}" || exit 0
flock -n 8 || exit 0

shopt -s nullglob
events=("${LABGATE_OUTBOX_DIRECTORY}"/event-*)
for event_file in "${events[@]}"; do
  if ! labgate_validate_outbox_filename "${event_file}"; then
    labgate_log "unknown webhook outbox filename retained: ${event_file}"
    break
  fi
  if ! labgate_read_outbox_event_file "${event_file}"; then
    labgate_log "unsafe or invalid webhook outbox file retained: ${event_file}"
    break
  fi

  payload=$(printf '{"credentialId":"%s","stateVersion":%s}' \
    "${LABGATE_OUTBOX_CREDENTIAL_ID}" "${LABGATE_OUTBOX_EVENT_STATE_VERSION}")
  if labgate_post_json "${LABGATE_OUTBOX_ENDPOINT}" "${payload}" >/dev/null 2>&1; then
    if ! rm -f -- "${event_file}" \
      || ! sync -f "${LABGATE_OUTBOX_DIRECTORY}"; then
      labgate_log "could not durably remove delivered webhook event: ${event_file}"
      break
    fi
  else
    # Preserve ordering across retries so close cannot overtake open.
    break
  fi
done

exit 0
