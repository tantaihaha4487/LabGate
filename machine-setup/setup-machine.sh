#!/usr/bin/env bash
set -euo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly PAM_HOOK_LINE='session required pam_exec.so /usr/local/sbin/guest-session-hook.sh'
readonly CONFIG_DIRECTORY=/etc/labgate

die() {
  printf 'setup-machine: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null || die "required command not found: $1"
}

select_pam_file() {
  local candidate

  if [[ -n ${LABGATE_PAM_FILE:-} ]]; then
    printf '%s\n' "${LABGATE_PAM_FILE}"
    return
  fi

  for candidate in /etc/pam.d/gdm-password /etc/pam.d/lightdm /etc/pam.d/sddm; do
    if [[ -f ${candidate} ]]; then
      printf '%s\n' "${candidate}"
      return
    fi
  done

  die "no supported display-manager PAM file found; set LABGATE_PAM_FILE"
}

[[ ${EUID} -eq 0 ]] || die "must run as root"

for command in curl getent hostname install passwd sed systemctl systemd-sysusers tailscale visudo; do
  require_command "${command}"
done

api_url=${LABGATE_API_URL:-}
machine_name=${LABGATE_MACHINE_NAME:-$(hostname -s)}
max_ttl_seconds=${LABGATE_MAX_TTL_SECONDS:-10800}

[[ ${api_url} =~ ^https?://[^[:space:]]+$ ]] || die "LABGATE_API_URL must be an HTTP(S) URL"
api_url=${api_url%/}
[[ ${machine_name} =~ ^[A-Za-z0-9._\ -]{1,64}$ ]] || die "machine name contains unsupported characters"
[[ ${max_ttl_seconds} =~ ^[0-9]+$ ]] && (( max_ttl_seconds > 0 )) || die "invalid maximum TTL"
getent passwd provisioner >/dev/null || die "provisioner account must already exist"

install -d -o root -g root -m 0755 \
  /etc/sysusers.d /etc/sudoers.d /etc/systemd/system /usr/local/sbin
install -o root -g root -m 0644 \
  "${SCRIPT_DIRECTORY}/labgate-guest.conf" /etc/sysusers.d/labgate-guest.conf
systemd-sysusers /etc/sysusers.d/labgate-guest.conf
getent passwd guest >/dev/null || die "systemd-sysusers did not create guest"
install -d -o guest -g guest -m 0700 /home/guest
passwd -l guest >/dev/null

visudo -cf "${SCRIPT_DIRECTORY}/sudoers-guest-provision" >/dev/null
install -o root -g root -m 0700 \
  "${SCRIPT_DIRECTORY}/guest-account.sh" /usr/local/sbin/guest-account.sh
install -o root -g root -m 0700 \
  "${SCRIPT_DIRECTORY}/guest-session-hook.sh" /usr/local/sbin/guest-session-hook.sh
install -o root -g root -m 0700 \
  "${SCRIPT_DIRECTORY}/guest-cleanup.sh" /usr/local/sbin/guest-cleanup.sh
install -o root -g root -m 0700 \
  "${SCRIPT_DIRECTORY}/guest-heartbeat.sh" /usr/local/sbin/guest-heartbeat.sh
install -o root -g root -m 0440 \
  "${SCRIPT_DIRECTORY}/sudoers-guest-provision" /etc/sudoers.d/labgate-guest-provision
install -o root -g root -m 0644 \
  "${SCRIPT_DIRECTORY}/guest-cleanup.service" /etc/systemd/system/guest-cleanup.service
install -o root -g root -m 0644 \
  "${SCRIPT_DIRECTORY}/guest-cleanup.timer" /etc/systemd/system/guest-cleanup.timer
install -o root -g root -m 0644 \
  "${SCRIPT_DIRECTORY}/guest-heartbeat.service" /etc/systemd/system/guest-heartbeat.service
install -o root -g root -m 0644 \
  "${SCRIPT_DIRECTORY}/guest-heartbeat.timer" /etc/systemd/system/guest-heartbeat.timer

pam_file=$(select_pam_file)
[[ -f ${pam_file} ]] || die "PAM file does not exist: ${pam_file}"
grep -Fqx "${PAM_HOOK_LINE}" "${pam_file}" || printf '%s\n' "${PAM_HOOK_LINE}" >>"${pam_file}"

if ! tailscale status >/dev/null 2>&1; then
  if [[ -n ${TAILSCALE_AUTH_KEY:-} ]]; then
    tailscale up --auth-key="${TAILSCALE_AUTH_KEY}"
  else
    tailscale up
  fi
fi

tailscale_ip=$(tailscale ip -4 | sed -n '1p')
[[ ${tailscale_ip} =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "could not determine Tailscale IPv4 address"

install -d -o root -g root -m 0700 "${CONFIG_DIRECTORY}"
printf '%s\n' "${api_url}" >"${CONFIG_DIRECTORY}/api-url"
printf '%s\n' "${max_ttl_seconds}" >"${CONFIG_DIRECTORY}/max-ttl-seconds"
chmod 0644 "${CONFIG_DIRECTORY}/api-url" "${CONFIG_DIRECTORY}/max-ttl-seconds"

if [[ ! -s ${CONFIG_DIRECTORY}/webhook-token ]]; then
  [[ -n ${LABGATE_REGISTRATION_SECRET:-} ]] || die "LABGATE_REGISTRATION_SECRET is required for first registration"
  response_file=$(mktemp)
  trap 'rm -f "${response_file}"' EXIT
  curl --fail --silent --show-error \
    --connect-timeout 3 --max-time 10 \
    --request POST \
    --header "Authorization: Bearer ${LABGATE_REGISTRATION_SECRET}" \
    --header 'Content-Type: application/json' \
    --output "${response_file}" \
    --data "{\"name\":\"${machine_name}\",\"tailscaleIp\":\"${tailscale_ip}\"}" \
    "${api_url}/api/admin/register-machine"
  webhook_token=$(sed -n 's/.*"webhookToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${response_file}")
  [[ ${webhook_token} =~ ^[A-Za-z0-9_-]{32,128}$ ]] || die "registration response did not contain a valid webhook token"
  printf '%s\n' "${webhook_token}" >"${CONFIG_DIRECTORY}/webhook-token"
  chmod 0600 "${CONFIG_DIRECTORY}/webhook-token"
fi

systemctl daemon-reload
systemctl enable --now guest-cleanup.timer
systemctl enable --now guest-heartbeat.timer

printf 'LabGate machine setup complete for %s (%s).\n' "${machine_name}" "${tailscale_ip}"
