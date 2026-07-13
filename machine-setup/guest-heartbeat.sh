#!/usr/bin/env bash
set -u

export PATH=/usr/sbin:/usr/bin:/sbin:/bin
readonly CONFIG_DIRECTORY=/etc/labgate

[[ -r ${CONFIG_DIRECTORY}/api-url ]] || exit 0
[[ -r ${CONFIG_DIRECTORY}/webhook-token ]] || exit 0
api_url=$(<"${CONFIG_DIRECTORY}/api-url")
token=$(<"${CONFIG_DIRECTORY}/webhook-token")
[[ -n ${api_url} && -n ${token} ]] || exit 0

curl --fail --silent --show-error \
  --connect-timeout 1 --max-time 2 \
  --request POST \
  --header "Authorization: Bearer ${token}" \
  --output /dev/null \
  "${api_url%/}/api/webhook/heartbeat" >/dev/null 2>&1 || true

exit 0
