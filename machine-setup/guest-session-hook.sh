#!/usr/bin/env bash
set -u

export PATH=/usr/sbin:/usr/bin:/sbin:/bin
readonly GUEST_HOME=/home/guest
readonly STATE_DIRECTORY=/run/labgate
readonly MOUNT_TIMESTAMP=${STATE_DIRECTORY}/guest-mounted-at
readonly ISSUED_TIMESTAMP=/var/lib/labgate/credential-issued-at
readonly CONFIG_DIRECTORY=/etc/labgate

post_webhook() {
  local endpoint=$1
  local api_url token

  [[ -r ${CONFIG_DIRECTORY}/api-url ]] || return 0
  [[ -r ${CONFIG_DIRECTORY}/webhook-token ]] || return 0
  api_url=$(<"${CONFIG_DIRECTORY}/api-url")
  token=$(<"${CONFIG_DIRECTORY}/webhook-token")
  [[ -n ${api_url} && -n ${token} ]] || return 0

  curl --fail --silent --show-error \
    --connect-timeout 1 --max-time 2 \
    --request POST \
    --header "Authorization: Bearer ${token}" \
    --output /dev/null \
    "${api_url%/}/api/webhook/${endpoint}" >/dev/null 2>&1 || true
}

[[ ${PAM_USER:-} == guest ]] || exit 0

case "${PAM_TYPE:-}" in
  open_session)
    guest_uid=$(id -u guest) || exit 1
    guest_gid=$(id -g guest) || exit 1
    install -d -o guest -g guest -m 0700 "${GUEST_HOME}" || exit 1
    install -d -o root -g root -m 0700 "${STATE_DIRECTORY}" || exit 1

    if mountpoint --quiet "${GUEST_HOME}"; then
      umount --lazy "${GUEST_HOME}" || exit 1
    fi

    mount --types tmpfs \
      --options "uid=${guest_uid},gid=${guest_gid},mode=0700,size=512M" \
      tmpfs "${GUEST_HOME}" || exit 1
    date +%s >"${MOUNT_TIMESTAMP}" || exit 1
    post_webhook session-open
    ;;
  close_session)
    failed=0
    if mountpoint --quiet "${GUEST_HOME}"; then
      umount --lazy "${GUEST_HOME}" || failed=1
    fi
    passwd -l guest >/dev/null || failed=1
    rm -f "${MOUNT_TIMESTAMP}" "${ISSUED_TIMESTAMP}"
    post_webhook session-close
    exit "${failed}"
    ;;
esac

exit 0
