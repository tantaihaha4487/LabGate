#!/usr/bin/env bash
set -u

export PATH=/usr/sbin:/usr/bin:/sbin:/bin
readonly GUEST_HOME=/home/guest
readonly MOUNT_TIMESTAMP=/run/labgate/guest-mounted-at
readonly MAX_TTL_FILE=/etc/labgate/max-ttl-seconds
readonly DEFAULT_MAX_TTL_SECONDS=10800

mountpoint --quiet "${GUEST_HOME}" || exit 0

max_ttl=${DEFAULT_MAX_TTL_SECONDS}
if [[ -r ${MAX_TTL_FILE} ]]; then
  configured_ttl=$(<"${MAX_TTL_FILE}")
  if [[ ${configured_ttl} =~ ^[0-9]+$ ]] && (( configured_ttl > 0 )); then
    max_ttl=${configured_ttl}
  fi
fi

should_cleanup=1
if [[ -r ${MOUNT_TIMESTAMP} ]]; then
  mounted_at=$(<"${MOUNT_TIMESTAMP}")
  if [[ ${mounted_at} =~ ^[0-9]+$ ]]; then
    now=$(date +%s)
    if (( now >= mounted_at && now - mounted_at < max_ttl )); then
      should_cleanup=0
    fi
  fi
fi

(( should_cleanup == 1 )) || exit 0

failed=0
umount --lazy "${GUEST_HOME}" || failed=1
passwd -l guest >/dev/null || failed=1
rm -f "${MOUNT_TIMESTAMP}"
exit "${failed}"
