#!/usr/bin/env bash
set -u

export PATH=/usr/sbin:/usr/bin:/sbin:/bin
readonly GUEST_HOME=/home/guest
readonly MOUNT_TIMESTAMP=/run/labgate/guest-mounted-at
readonly ISSUED_TIMESTAMP=/var/lib/labgate/credential-issued-at
readonly MAX_TTL_FILE=/etc/labgate/max-ttl-seconds
readonly CONFIG_DIRECTORY=/etc/labgate
readonly DEFAULT_MAX_TTL_SECONDS=180

post_expiration_webhook() {
  local api_url token

  [[ -r ${CONFIG_DIRECTORY}/api-url ]] || return 1
  [[ -r ${CONFIG_DIRECTORY}/webhook-token ]] || return 1
  api_url=$(<"${CONFIG_DIRECTORY}/api-url")
  token=$(<"${CONFIG_DIRECTORY}/webhook-token")
  [[ -n ${api_url} && -n ${token} ]] || return 1

  curl --fail --silent --show-error \
    --connect-timeout 1 --max-time 2 \
    --request POST \
    --header "Authorization: Bearer ${token}" \
    --output /dev/null \
    "${api_url%/}/api/webhook/credential-expired" >/dev/null 2>&1
}

max_ttl=${DEFAULT_MAX_TTL_SECONDS}
if [[ -r ${MAX_TTL_FILE} ]]; then
  configured_ttl=$(<"${MAX_TTL_FILE}")
  if [[ ${configured_ttl} =~ ^[0-9]+$ ]] && (( configured_ttl > 0 )); then
    max_ttl=${configured_ttl}
  fi
fi

started_at=
if [[ -r ${ISSUED_TIMESTAMP} ]]; then
  started_at=$(<"${ISSUED_TIMESTAMP}")
elif [[ -r ${MOUNT_TIMESTAMP} ]]; then
  started_at=$(<"${MOUNT_TIMESTAMP}")
elif ! mountpoint --quiet "${GUEST_HOME}"; then
  exit 0
fi

if [[ ${started_at} =~ ^[0-9]+$ ]]; then
  now=$(date +%s)
  if (( now >= started_at && now - started_at < max_ttl )); then
    exit 0
  fi
fi

failed=0
if mountpoint --quiet "${GUEST_HOME}"; then
  umount --lazy "${GUEST_HOME}" || failed=1
fi
passwd -l guest >/dev/null || failed=1

if (( failed == 0 )) && post_expiration_webhook; then
  rm -f "${MOUNT_TIMESTAMP}" "${ISSUED_TIMESTAMP}"
fi

exit "${failed}"
