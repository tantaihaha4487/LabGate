#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly COMMON_INSTALL_DIRECTORY=/usr/local/lib/labgate
readonly CONFIG_DIRECTORY=/etc/labgate
readonly PAM_HOOK_LINE='session required pam_exec.so quiet /usr/local/sbin/guest-session-hook.sh'
readonly LEGACY_PAM_HOOK_LINE='session required pam_exec.so /usr/local/sbin/guest-session-hook.sh'
readonly PAM_GUEST_DENY_LINE='account requisite pam_succeed_if.so quiet user != guest'
readonly PAM_PROVISIONER_DENY_LINE='account requisite pam_succeed_if.so quiet user != provisioner'
readonly PAM_GUEST_ACCOUNT_CHANGE_AUTH_LINE='auth requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh'
readonly PAM_GUEST_ACCOUNT_CHANGE_PASSWORD_LINE='password requisite pam_exec.so quiet /usr/local/sbin/labgate-deny-guest-account-change.sh'
readonly SSHD_CONFIG=/etc/ssh/sshd_config
readonly SSHD_DROPIN_DIRECTORY=/etc/ssh/sshd_config.d
readonly SSHD_DROPIN=${SSHD_DROPIN_DIRECTORY}/99-labgate-guest.conf
readonly SSHD_BLOCK_BEGIN='# BEGIN LABGATE PROVISIONER FORCE COMMAND'
readonly SSHD_BLOCK_END='# END LABGATE PROVISIONER FORCE COMMAND'
readonly POLKIT_RULES_DIRECTORY=/etc/polkit-1/rules.d
readonly POLKIT_RULE=${POLKIT_RULES_DIRECTORY}/00-labgate-deny-guest.rules

temporary_files=()
cleanup() {
  if (( ${#temporary_files[@]} > 0 )); then
    rm -f -- "${temporary_files[@]}"
  fi
}
trap cleanup EXIT

die() {
  printf 'setup-machine: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null || die "required command not found: $1"
}

quiesce_legacy_outbox_worker() {
  local active_state enabled_state load_state unit

  # A failed migration must not reboot into the old clock-ordered worker. Leave
  # the timer disabled until this installer reaches its normal enable step.
  systemctl disable --now guest-webhook-flush.timer >/dev/null 2>&1 || true
  systemctl stop guest-webhook-flush.service >/dev/null 2>&1 || true
  enabled_state=$(systemctl is-enabled guest-webhook-flush.timer 2>/dev/null || true)
  case "${enabled_state}" in
    disabled|masked|not-found) ;;
    *) die "guest-webhook-flush.timer remains enabled or its enablement state is unknown" ;;
  esac
  for unit in guest-webhook-flush.timer guest-webhook-flush.service; do
    load_state=$(systemctl show "${unit}" --property=LoadState --value 2>/dev/null) \
      || die "could not inspect ${unit} before legacy outbox migration"
    case "${load_state}" in
      loaded|not-found) ;;
      *) die "${unit} has an unsafe load state before legacy outbox migration" ;;
    esac
    active_state=$(systemctl show "${unit}" --property=ActiveState --value 2>/dev/null) \
      || die "could not inspect ${unit} activity before legacy outbox migration"
    case "${active_state}" in
      inactive|failed) ;;
      *) die "${unit} is not quiescent for legacy outbox migration" ;;
    esac
  done
}

audit_guest_sudo_boundary() {
  local sudo_audit_expected sudo_audit_hostname sudo_audit_output

  # Query sudo's resolved policy instead of attempting to counter existing
  # grants with a deny entry: sudoers ordering and specificity can override a
  # local deny. In the C locale sudo 1.9 returns exit 0 and exactly this single
  # denial line when the named user has no command grant. Any warning, extra
  # line, different exit, or allow-list is ambiguous and therefore fatal.
  visudo -c >/dev/null 2>&1 \
    || die "global sudoers policy is invalid"
  sudo_audit_hostname=$(hostname) \
    || die "could not determine the hostname for the sudo policy audit"
  [[ ${sudo_audit_hostname} =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$ ]] \
    || die "hostname is not canonical enough for the sudo policy audit"
  sudo_audit_expected="User guest is not allowed to run sudo on ${sudo_audit_hostname}."
  sudo_audit_output=$(sudo -n -l -U guest 2>&1) \
    || die "could not resolve effective sudo privileges for guest"
  [[ ${sudo_audit_output} == "${sudo_audit_expected}" ]] \
    || die "guest has a sudo command grant or sudo policy could not be proven grant-free"
}

account_password_is_locked() {
  local account=$1 reported_account status

  read -r reported_account status _ < <(passwd -S "${account}" 2>/dev/null) || return 1
  [[ ${reported_account} == "${account}" && ${status} =~ ^(L|LK)$ ]]
}

new_temporary_file() {
  local destination_name=$1 temporary

  temporary=$(mktemp) || die "could not create a temporary file"
  temporary_files+=("${temporary}")
  chmod 0600 "${temporary}"
  printf -v "${destination_name}" '%s' "${temporary}"
}

select_pam_file() {
  local fragment resolved service

  if [[ -n ${LABGATE_PAM_FILE:-} ]]; then
    resolved=$(readlink -f -- "${LABGATE_PAM_FILE}" 2>/dev/null || true)
    [[ ${resolved} == /etc/pam.d/* && ${resolved%/*} == /etc/pam.d ]] \
      || die "LABGATE_PAM_FILE must resolve directly under /etc/pam.d"
    printf '%s\n' "${resolved}"
    return
  fi

  fragment=$(systemctl show display-manager.service --property=FragmentPath --value 2>/dev/null || true)
  if [[ -z ${fragment} && -L /etc/systemd/system/display-manager.service ]]; then
    fragment=$(readlink -f /etc/systemd/system/display-manager.service || true)
  fi
  [[ -n ${fragment} ]] || die "no configured display manager found; set LABGATE_PAM_FILE explicitly"
  service=$(basename -- "${fragment}")

  case "${service}" in
    gdm.service|gdm3.service)
      printf '%s\n' /etc/pam.d/gdm-password
      ;;
    lightdm.service)
      printf '%s\n' /etc/pam.d/lightdm
      ;;
    sddm.service)
      printf '%s\n' /etc/pam.d/sddm
      ;;
    *)
      die "unsupported configured display manager ${service}; set LABGATE_PAM_FILE explicitly"
      ;;
  esac
}

prepend_unique_line() {
  local destination=$1 legacy_line=${3:-} line=$2 rewritten

  [[ -f ${destination} && ! -L ${destination} ]] || die "unsafe or missing PAM file: ${destination}"
  new_temporary_file rewritten
  {
    printf '%s\n' "${line}"
    awk -v exact="${line}" -v legacy="${legacy_line}" \
      '$0 != exact && (legacy == "" || $0 != legacy) { print }' "${destination}"
  } >"${rewritten}"
  chown root:root "${rewritten}"
  chmod --reference="${destination}" "${rewritten}"
  mv -f -- "${rewritten}" "${destination}"
}

remove_known_pam_hooks() {
  local destination=$1 rewritten

  [[ -f ${destination} && ! -L ${destination} ]] || return 0
  if ! grep -Fqx "${PAM_HOOK_LINE}" "${destination}" \
    && ! grep -Fqx "${LEGACY_PAM_HOOK_LINE}" "${destination}"; then
    return 0
  fi
  new_temporary_file rewritten
  awk -v exact="${PAM_HOOK_LINE}" -v legacy="${LEGACY_PAM_HOOK_LINE}" \
    '$0 != exact && $0 != legacy { print }' "${destination}" >"${rewritten}"
  chown root:root "${rewritten}"
  chmod --reference="${destination}" "${rewritten}"
  mv -f -- "${rewritten}" "${destination}"
}

remove_exact_policy_entry() {
  local destination=$1 entry=$2 rewritten

  [[ -e ${destination} || -L ${destination} ]] || return 0
  [[ -f ${destination} && ! -L ${destination} ]] \
    || die "unsafe policy file: ${destination}"
  new_temporary_file rewritten
  awk -v exact="${entry}" '$0 != exact { print }' "${destination}" >"${rewritten}"
  chown root:root "${rewritten}"
  chmod --reference="${destination}" "${rewritten}"
  mv -f -- "${rewritten}" "${destination}"
}

ensure_deny_policy_entry() {
  local destination=$1 entry=$2

  [[ ! -L ${destination} ]] || die "unsafe policy symlink: ${destination}"
  if [[ ! -e ${destination} ]]; then
    install -o root -g root -m 0644 /dev/null "${destination}"
  fi
  prepend_unique_line "${destination}" "${entry}"
}

install_alternate_display_manager_denials() {
  local alternate candidate candidate_name known prefix selected=$1
  local -a alternates

  case "$(basename -- "${selected}")" in
    gdm-password)
      prefix=gdm
      known='gdm-password gdm-autologin gdm-fingerprint gdm-smartcard gdm-launch-environment'
      alternates=(gdm-autologin gdm-fingerprint gdm-smartcard)
      ;;
    lightdm)
      prefix=lightdm
      known='lightdm lightdm-autologin lightdm-greeter'
      alternates=(lightdm-autologin)
      ;;
    sddm)
      prefix=sddm
      known='sddm sddm-autologin sddm-greeter'
      alternates=(sddm-autologin)
      ;;
    *)
      die "cannot classify selected display-manager PAM service: ${selected}"
      ;;
  esac

  for candidate in /etc/pam.d/${prefix}*; do
    [[ -e ${candidate} || -L ${candidate} ]] || continue
    candidate_name=$(basename -- "${candidate}")
    case " ${known} " in
      *" ${candidate_name} "*) ;;
      *)
        die "unknown ${prefix} PAM authentication path ${candidate_name}; review it before installing LabGate"
        ;;
    esac
  done

  for alternate in "${alternates[@]}"; do
    candidate=/etc/pam.d/${alternate}
    [[ -e ${candidate} || -L ${candidate} ]] || continue
    [[ -f ${candidate} && ! -L ${candidate} ]] \
      || die "unsafe alternate display-manager PAM file: ${candidate}"
    prepend_unique_line "${candidate}" "${PAM_GUEST_DENY_LINE}"
    prepend_unique_line "${candidate}" "${PAM_PROVISIONER_DENY_LINE}"
  done
}

declare -A pam_auth_visited=()
pam_auth_stack_contains_module() {
  local included module=$2 pam_file=$1

  [[ ${pam_file} == /etc/pam.d/* && ${pam_file%/*} == /etc/pam.d \
    && -f ${pam_file} && ! -L ${pam_file} ]] || return 2
  [[ -z ${pam_auth_visited[${pam_file}]:-} ]] || return 1
  pam_auth_visited[${pam_file}]=1

  if awk -v target="${module}" '
    $1 ~ /^-?auth$/ {
      for (i = 2; i <= NF; i++) {
        value = $i
        sub(/^.*\//, "", value)
        if (value == target) { found = 1; exit }
      }
    }
    END { exit !found }
  ' "${pam_file}"; then
    return 0
  fi

  while IFS= read -r included; do
    [[ ${included} =~ ^[A-Za-z0-9._-]+$ ]] || return 2
    if pam_auth_stack_contains_module "/etc/pam.d/${included}" "${module}"; then
      return 0
    else
      case $? in
        1) ;;
        *) return 2 ;;
      esac
    fi
  done < <(awk '
    $1 == "@include" { print $2 }
    $1 ~ /^-?auth$/ && ($2 == "include" || $2 == "substack") { print $3 }
  ' "${pam_file}")

  return 1
}

install_sshd_policy() {
  local dropin_existed=0 dropin_backup effective main_backup rewritten validated=1

  [[ -f ${SSHD_CONFIG} && ! -L ${SSHD_CONFIG} ]] || die "unsafe or missing sshd_config"
  install -d -o root -g root -m 0755 "${SSHD_DROPIN_DIRECTORY}"
  new_temporary_file main_backup
  cp --preserve=mode,ownership,timestamps -- "${SSHD_CONFIG}" "${main_backup}"
  new_temporary_file dropin_backup
  if [[ -e ${SSHD_DROPIN} ]]; then
    [[ -f ${SSHD_DROPIN} && ! -L ${SSHD_DROPIN} ]] || die "unsafe existing LabGate sshd drop-in"
    cp --preserve=mode,ownership,timestamps -- "${SSHD_DROPIN}" "${dropin_backup}"
    dropin_existed=1
  fi

  install -o root -g root -m 0644 \
    "${SCRIPT_DIRECTORY}/sshd-labgate-guest.conf" "${SSHD_DROPIN}"

  new_temporary_file rewritten
  awk -v begin="${SSHD_BLOCK_BEGIN}" -v end="${SSHD_BLOCK_END}" '
    $0 == begin { if (inside) exit 42; inside=1; next }
    $0 == end { if (!inside) exit 42; inside=0; next }
    !inside { print }
    END { if (inside) exit 42 }
  ' "${SSHD_CONFIG}" >"${rewritten}" || die "existing LabGate sshd block is malformed"
  {
    printf '\n%s\n' "${SSHD_BLOCK_BEGIN}"
    printf 'Match User provisioner\n'
    printf '    ForceCommand /usr/local/sbin/labgate-provisioner-dispatch.sh\n'
    printf '    AuthenticationMethods publickey\n'
    printf '    PubkeyAuthentication yes\n'
    printf '    PasswordAuthentication no\n'
    printf '    KbdInteractiveAuthentication no\n'
    printf '    HostbasedAuthentication no\n'
    printf '    GSSAPIAuthentication no\n'
    printf '    KerberosAuthentication no\n'
    printf '    PermitEmptyPasswords no\n'
    printf '    PermitUserRC no\n'
    printf '    DisableForwarding yes\n'
    printf '    AllowAgentForwarding no\n'
    printf '    AllowTcpForwarding no\n'
    printf '    X11Forwarding no\n'
    printf '    PermitTunnel no\n'
    printf '    PermitTTY no\n'
    printf '%s\n' "${SSHD_BLOCK_END}"
  } >>"${rewritten}"
  chown root:root "${rewritten}"
  chmod --reference="${SSHD_CONFIG}" "${rewritten}"
  mv -f -- "${rewritten}" "${SSHD_CONFIG}"

  sshd -t || validated=0
  if (( validated == 1 )); then
    sshd -T -C user=guest,host=localhost,addr=127.0.0.1 2>/dev/null \
      | awk '$1 == "denyusers" { for (i=2; i<=NF; i++) if ($i == "guest") found=1 } END { exit !found }' \
      || validated=0
  fi
  if (( validated == 1 )); then
    effective=$(sshd -T -C user=provisioner,host=localhost,addr=127.0.0.1 2>/dev/null) \
      || validated=0
  fi
  if (( validated == 1 )); then
    for required_setting in \
      'forcecommand /usr/local/sbin/labgate-provisioner-dispatch.sh' \
      'authenticationmethods publickey' \
      'pubkeyauthentication yes' \
      'passwordauthentication no' \
      'kbdinteractiveauthentication no' \
      'hostbasedauthentication no' \
      'gssapiauthentication no' \
      'kerberosauthentication no' \
      'permitemptypasswords no' \
      'permituserrc no' \
      'permituserenvironment no' \
      'disableforwarding yes' \
      'allowagentforwarding no' \
      'allowtcpforwarding no' \
      'x11forwarding no' \
      'permittunnel no' \
      'permittty no'; do
      grep -Fqx "${required_setting}" <<<"${effective}" || validated=0
    done
  fi
  if (( validated == 1 )); then
    # AcceptEnv entries accumulate across the main configuration and includes.
    # Locale variables are harmless here because the dispatcher resets LC_ALL;
    # every other client-supplied environment name is rejected.
    awk '
      $1 == "acceptenv" {
        for (i = 2; i <= NF; i++) {
          if ($i != "LANG" && $i !~ /^LC_[A-Za-z0-9_*?]+$/) exit 1
        }
      }
    ' <<<"${effective}" || validated=0
  fi

  if (( validated == 0 )); then
    cp --preserve=mode,ownership,timestamps -- "${main_backup}" "${SSHD_CONFIG}"
    if (( dropin_existed == 1 )); then
      cp --preserve=mode,ownership,timestamps -- "${dropin_backup}" "${SSHD_DROPIN}"
    else
      rm -f -- "${SSHD_DROPIN}"
    fi
    sshd -t || true
    die "sshd rejected the LabGate policy; previous SSH configuration restored"
  fi
}

activate_sshd_policy() {
  if systemctl is-active --quiet ssh.service; then
    systemctl reload ssh.service \
      || die "could not reload ssh.service with the validated LabGate policy"
  elif systemctl is-active --quiet sshd.service; then
    systemctl reload sshd.service \
      || die "could not reload sshd.service with the validated LabGate policy"
  elif systemctl is-active --quiet ssh.socket \
    || systemctl is-active --quiet sshd.socket; then
    # A socket-activated daemon reads the already-validated configuration when
    # the next connection starts. No persistent daemon exists to reload.
    :
  else
    die "no active SSH service or socket found; provisioner remains disabled"
  fi
}

write_webhook_curl_config() {
  local token=$1 webhook_curl_config

  [[ ${token} =~ ^[A-Za-z0-9_-]{32,128}$ ]] || die "invalid webhook token"
  new_temporary_file webhook_curl_config
  {
    printf 'header = "Authorization: Bearer %s"\n' "${token}"
    printf 'header = "Content-Type: application/json"\n'
  } >"${webhook_curl_config}"
  install -o root -g root -m 0600 \
    "${webhook_curl_config}" "${CONFIG_DIRECTORY}/webhook-curl.conf"
}

register_machine() {
  local auth_config fingerprint=$2 pin_file request_file response_file secret=$1 token token_file

  labgate_validate_registration_secret "${secret}" \
    || die "LABGATE_REGISTRATION_SECRET must be a 20-256 character RFC 6750 b64token"
  labgate_validate_ssh_host_key_sha256 "${fingerprint}" \
    || die "local Ed25519 SSH host-key fingerprint is invalid"
  new_temporary_file auth_config
  new_temporary_file request_file
  new_temporary_file response_file
  {
    printf 'header = "Authorization: Bearer %s"\n' "${secret}"
    printf 'header = "Content-Type: application/json"\n'
  } >"${auth_config}"
  printf '{"name":"%s","tailscaleIp":"%s","sshHostKeySha256":"%s"}\n' \
    "${machine_name}" "${tailscale_ip}" "${fingerprint}" >"${request_file}"

  curl --config "${auth_config}" \
    --fail --silent --show-error \
    --connect-timeout 3 --max-time 10 \
    --request POST \
    --data-binary "@${request_file}" \
    --output "${response_file}" \
    --url "${api_url}/api/admin/register-machine"
  token=$(sed -n 's/.*"webhookToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${response_file}")
  [[ ${token} =~ ^[A-Za-z0-9_-]{32,128}$ ]] || die "registration response did not contain a valid webhook token"
  new_temporary_file pin_file
  new_temporary_file token_file
  printf '%s\n' "${fingerprint}" >"${pin_file}"
  printf '%s\n' "${token}" >"${token_file}"
  # Publish the non-secret pin marker first. If token publication is interrupted,
  # an exact idempotent POST can recover it; the reverse order could leave a
  # token-bearing installation that looks indistinguishable from a legacy null pin.
  install -o root -g root -m 0600 \
    "${pin_file}" "${CONFIG_DIRECTORY}/ssh-host-key-sha256"
  install -o root -g root -m 0600 \
    "${token_file}" "${CONFIG_DIRECTORY}/webhook-token"
}

[[ ${EUID} -eq 0 ]] || die "must run as root"

for command in \
  awk bash basename chage chfn chown chmod chpasswd chsh cmp cp curl date find findmnt flock getent grep hostname id \
  install ipcrm ipcs keyctl logger loginctl mktemp mount mountpoint mv nologin passwd pgrep pkill readlink rm sed sshd \
  pkaction sha256sum sh sleep ssh-keygen stat sudo sync systemctl systemd-sysusers tailscale timedatectl timeout tr umount visudo; do
  require_command "${command}"
done

clock_synchronized=$(timedatectl show --property=NTPSynchronized --value 2>/dev/null || true)
[[ ${clock_synchronized} == yes ]] \
  || die "system clock must be NTP-synchronized before installing LabGate"

[[ -d ${POLKIT_RULES_DIRECTORY} && ! -L ${POLKIT_RULES_DIRECTORY} ]] \
  || die "Polkit rules directory is missing or unsafe: ${POLKIT_RULES_DIRECTORY}"
# Arch-family polkit commonly uses root:polkitd for this directory. Root
# ownership plus a non-writable group/other mode keeps the directory root-
# controlled without requiring a distro-specific group name. The installed
# LabGate rule below remains strictly root:root 0644.
[[ $(stat -c '%u' -- "${POLKIT_RULES_DIRECTORY}") == 0 ]] \
  || die "Polkit rules directory must be owned by root"
polkit_rules_mode=$(stat -c '%a' -- "${POLKIT_RULES_DIRECTORY}")
[[ ${polkit_rules_mode} =~ ^[0-7]{3,4}$ ]] \
  && (( (8#${polkit_rules_mode} & 8#022) == 0 )) \
  || die "Polkit rules directory must not be group- or world-writable"
pkaction --version >/dev/null 2>&1 \
  || die "Polkit tooling is unavailable"
timeout --signal=KILL 5 pkaction >/dev/null 2>&1 \
  || die "Polkit authority is unavailable"
[[ -f ${SCRIPT_DIRECTORY}/00-labgate-deny-guest.rules \
  && ! -L ${SCRIPT_DIRECTORY}/00-labgate-deny-guest.rules ]] \
  || die "committed LabGate Polkit rule is missing or unsafe"

find /lib /usr/lib -type f -name pam_exec.so -print -quit 2>/dev/null | grep -q . \
  || die "pam_exec.so is required"
find /lib /usr/lib -type f -name pam_succeed_if.so -print -quit 2>/dev/null | grep -q . \
  || die "pam_succeed_if.so is required"

for script in \
  guest-account.sh guest-boot-lock.sh guest-cleanup.sh guest-heartbeat.sh guest-session-hook.sh \
  guest-webhook-flush.sh labgate-common.sh setup-machine.sh; do
  bash -n "${SCRIPT_DIRECTORY}/${script}" || die "invalid shell syntax in ${script}"
done
sh -n "${SCRIPT_DIRECTORY}/labgate-provisioner-dispatch.sh" \
  || die "invalid shell syntax in labgate-provisioner-dispatch.sh"
sh -n "${SCRIPT_DIRECTORY}/labgate-deny-guest-account-change.sh" \
  || die "invalid shell syntax in labgate-deny-guest-account-change.sh"

# Inspect the persistent queue with the new parser before changing account,
# PAM, SSH, or systemd policy. An old queue is migrated only through the
# explicit drained-maintenance opt-in below; malformed state is never guessed.
# shellcheck source=labgate-common.sh
source "${SCRIPT_DIRECTORY}/labgate-common.sh" \
  || die "could not load committed lifecycle library"
labgate_inventory_outbox \
  || die "unsafe or invalid webhook outbox; preserve it and follow the recovery runbook"
case "${LABGATE_MIGRATE_LEGACY_OUTBOX:-}" in
  '') ;;
  1) ;;
  *) die "LABGATE_MIGRATE_LEGACY_OUTBOX must be unset or exactly 1" ;;
esac
legacy_outbox_migration_required=0
if (( LABGATE_LEGACY_OUTBOX_COUNT > 0 \
  || LABGATE_LEGACY_OUTBOX_MIGRATION_COUNT > 0 )); then
  [[ ${LABGATE_MIGRATE_LEGACY_OUTBOX:-} == 1 ]] \
    || die "legacy webhook outbox requires a drained update with LABGATE_MIGRATE_LEGACY_OUTBOX=1"
  legacy_outbox_migration_required=1
fi

api_url=${LABGATE_API_URL:-}
machine_name=${LABGATE_MACHINE_NAME:-$(hostname -s)}
password_length=8
if [[ ${LABGATE_PASSWORD_LENGTH+x} ]]; then
  password_length=${LABGATE_PASSWORD_LENGTH}
elif [[ -e ${CONFIG_DIRECTORY}/password-length || -L ${CONFIG_DIRECTORY}/password-length ]]; then
  [[ -f ${CONFIG_DIRECTORY}/password-length && ! -L ${CONFIG_DIRECTORY}/password-length ]] \
    || die "existing password-length configuration is unsafe"
  [[ $(stat -c '%u' -- "${CONFIG_DIRECTORY}/password-length") == 0 ]] \
    || die "existing password-length configuration is not root-owned"
  existing_password_mode=$(stat -c '%a' -- "${CONFIG_DIRECTORY}/password-length")
  (( (8#${existing_password_mode} & 8#022) == 0 )) \
    || die "existing password-length configuration is writable by another user"
  IFS= read -r password_length <"${CONFIG_DIRECTORY}/password-length" \
    || die "could not read existing password-length configuration"
fi

labgate_validate_api_origin "${api_url}" \
  || die "LABGATE_API_URL must be an origin-only HTTP(S) URL with a canonical hostname or IPv4 address and optional port 1-65535"
[[ ${machine_name} =~ ^[A-Za-z0-9._\ -]{1,64}$ ]] || die "machine name contains unsupported characters"
[[ ${password_length} =~ ^[0-9]{1,3}$ ]] \
  && (( 10#${password_length} >= 5 && 10#${password_length} <= 128 )) \
  || die "LABGATE_PASSWORD_LENGTH must be between 5 and 128"
ssh_host_key_sha256=$(labgate_compute_ssh_host_key_sha256) \
  || die "could not derive the canonical Ed25519 SSH host-key SHA256 fingerprint"
existing_webhook_token=
persisted_ssh_host_key_sha256=
for existing_identity_file in \
  "${CONFIG_DIRECTORY}/webhook-token" \
  "${CONFIG_DIRECTORY}/ssh-host-key-sha256"; do
  if [[ -e ${existing_identity_file} || -L ${existing_identity_file} ]]; then
    [[ -f ${existing_identity_file} && ! -L ${existing_identity_file} ]] \
      || die "unsafe existing machine identity file: ${existing_identity_file}"
    labgate_file_is_root_controlled "${existing_identity_file}" \
      || die "existing machine identity file is not root-controlled: ${existing_identity_file}"
  fi
done
if [[ -e ${CONFIG_DIRECTORY}/ssh-host-key-sha256 ]]; then
  persisted_ssh_host_key_sha256=$(labgate_read_persisted_ssh_host_key_sha256) \
    || die "the local SSH host-key pin marker is invalid"
  [[ ${persisted_ssh_host_key_sha256} == "${ssh_host_key_sha256}" ]] \
    || die "the local Ed25519 SSH host key changed; keep the endpoint drained and complete the explicit rekey procedure"
fi
if [[ -s ${CONFIG_DIRECTORY}/webhook-token ]]; then
  IFS= read -r existing_webhook_token <"${CONFIG_DIRECTORY}/webhook-token" \
    || die "could not read the existing webhook token"
  [[ ${existing_webhook_token} =~ ^[A-Za-z0-9_-]{32,128}$ ]] \
    || die "existing webhook token is invalid"
  [[ -n ${persisted_ssh_host_key_sha256} ]] \
    || die "existing token has no local SSH host-key pin marker; keep the endpoint drained and complete the explicit legacy-null rekey procedure"
fi
if [[ -z ${existing_webhook_token} ]]; then
  labgate_validate_registration_secret "${LABGATE_REGISTRATION_SECRET:-}" \
    || die "LABGATE_REGISTRATION_SECRET must be supplied and valid before first-registration setup can change account, PAM, or SSH policy"
fi
getent passwd provisioner >/dev/null || die "provisioner account must already exist"

# Disable the service identity before installing any privileged artifact. If
# setup fails at any later point, existing authorized keys remain fail-closed
# behind nologin instead of retaining a general shell.
provisioner_record=$(getent passwd provisioner)
IFS=: read -r provisioner_name _ provisioner_uid _ _ provisioner_home provisioner_shell <<<"${provisioner_record}"
[[ ${provisioner_name} == provisioner && ${provisioner_uid} != 0 ]] \
  || die "provisioner must be a non-root account"
[[ ${provisioner_home} != /home/guest && -d ${provisioner_home} && ! -L ${provisioner_home} ]] \
  || die "provisioner account home must be a real directory separate from /home/guest"
[[ $(stat -c '%u' -- "${provisioner_home}") == 0 ]] \
  || die "provisioner account home must be root-owned"
provisioner_home_mode=$(stat -c '%a' -- "${provisioner_home}")
(( (8#${provisioner_home_mode} & 8#022) == 0 )) \
  || die "provisioner account home must not be group- or world-writable"
getent passwd | awk -F: -v uid="${provisioner_uid}" '$3 == uid { count++ } END { exit count == 1 ? 0 : 1 }' \
  || die "provisioner UID must not be shared with another account"
[[ -x /usr/bin/sudo && ! -L /usr/bin/sudo && $(stat -c '%u' -- /usr/bin/sudo) == 0 ]] \
  || die "/usr/bin/sudo must be an executable root-owned regular file"
provisioner_shell_target=$(readlink -f -- /bin/sh 2>/dev/null || true)
[[ -n ${provisioner_shell_target} && -f ${provisioner_shell_target} \
  && ! -L ${provisioner_shell_target} && -x ${provisioner_shell_target} \
  && $(stat -c '%u' -- "${provisioner_shell_target}") == 0 ]] \
  || die "/bin/sh must resolve to an executable root-owned regular file"
provisioner_shell_mode=$(stat -c '%a' -- "${provisioner_shell_target}")
(( (8#${provisioner_shell_mode} & 8#022) == 0 )) \
  || die "/bin/sh target must not be group- or world-writable"
provisioner_lock_shell=$(command -v nologin)
provisioner_lock_shell_target=$(readlink -f -- "${provisioner_lock_shell}" 2>/dev/null || true)
[[ -n ${provisioner_lock_shell_target} && -f ${provisioner_lock_shell_target} \
  && ! -L ${provisioner_lock_shell_target} && -x ${provisioner_lock_shell_target} \
  && $(stat -c '%u' -- "${provisioner_lock_shell_target}") == 0 ]] \
  || die "nologin must resolve to an executable root-owned regular file"
provisioner_lock_shell_mode=$(stat -c '%a' -- "${provisioner_lock_shell_target}")
(( (8#${provisioner_lock_shell_mode} & 8#022) == 0 )) \
  || die "nologin target must not be group- or world-writable"
if [[ ${provisioner_shell} != "${provisioner_lock_shell}" ]]; then
  chsh --shell "${provisioner_lock_shell}" provisioner \
    || die "could not disable the provisioner login shell"
fi
[[ $(getent passwd provisioner | awk -F: '{ print $7 }') == "${provisioner_lock_shell}" ]] \
  || die "provisioner login shell did not enter fail-closed maintenance mode"
passwd -l provisioner >/dev/null 2>&1 \
  || die "could not lock the provisioner password"
account_password_is_locked provisioner \
  || die "provisioner password is not locked"
loginctl terminate-user provisioner >/dev/null 2>&1 || true
pkill -TERM -u "${provisioner_uid}" >/dev/null 2>&1 || true
pkill -TERM -U "${provisioner_uid}" >/dev/null 2>&1 || true
for _ in {1..20}; do
  if ! pgrep -u "${provisioner_uid}" >/dev/null 2>&1 \
    && ! pgrep -U "${provisioner_uid}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if pgrep -u "${provisioner_uid}" >/dev/null 2>&1 \
  || pgrep -U "${provisioner_uid}" >/dev/null 2>&1; then
  pkill -KILL -u "${provisioner_uid}" >/dev/null 2>&1 || true
  pkill -KILL -U "${provisioner_uid}" >/dev/null 2>&1 || true
  sleep 0.2
fi
! pgrep -u "${provisioner_uid}" >/dev/null 2>&1 \
  && ! pgrep -U "${provisioner_uid}" >/dev/null 2>&1 \
  || die "could not terminate existing provisioner processes"

install -d -o root -g root -m 0755 \
  /etc/sysusers.d /etc/sudoers.d /etc/systemd/system /usr/local/sbin
install -d -o root -g root -m 0700 \
  "${COMMON_INSTALL_DIRECTORY}" "${CONFIG_DIRECTORY}" /var/lib/labgate \
  /var/lib/labgate/outbox /var/lib/labgate/tombstones
if [[ -e ${POLKIT_RULE} || -L ${POLKIT_RULE} ]]; then
  [[ -f ${POLKIT_RULE} && ! -L ${POLKIT_RULE} ]] \
    || die "unsafe existing LabGate Polkit rule"
fi
install -o root -g root -m 0644 \
  "${SCRIPT_DIRECTORY}/00-labgate-deny-guest.rules" "${POLKIT_RULE}"
[[ -f ${POLKIT_RULE} && ! -L ${POLKIT_RULE} \
  && $(stat -c '%u:%g' -- "${POLKIT_RULE}") == 0:0 \
  && $(stat -c '%a' -- "${POLKIT_RULE}") == 644 ]] \
  || die "installed LabGate Polkit rule has unsafe metadata"
cmp -s -- "${SCRIPT_DIRECTORY}/00-labgate-deny-guest.rules" "${POLKIT_RULE}" \
  || die "installed LabGate Polkit rule differs from the committed artifact"
install -o root -g root -m 0644 \
  "${SCRIPT_DIRECTORY}/labgate-guest.conf" /etc/sysusers.d/labgate-guest.conf
systemd-sysusers /etc/sysusers.d/labgate-guest.conf
getent passwd guest >/dev/null || die "systemd-sysusers did not create guest"
[[ ! -L /home/guest ]] || die "/home/guest must not be a symbolic link"

guest_record=$(getent passwd guest)
IFS=: read -r guest_name _ guest_uid guest_gid _ guest_home guest_shell <<<"${guest_record}"
[[ ${guest_name} == guest && ${guest_home} == /home/guest && ${guest_shell} == /bin/bash ]] \
  || die "guest account must use home /home/guest and shell /bin/bash"
getent passwd | awk -F: -v uid="${guest_uid}" '$3 == uid { count++ } END { exit count == 1 ? 0 : 1 }' \
  || die "guest UID must not be shared with another account"
guest_group_record=$(getent group "${guest_gid}")
IFS=: read -r guest_group_name _ guest_group_gid _ <<<"${guest_group_record}"
[[ ${guest_group_name} == guest && ${guest_group_gid} == "${guest_gid}" ]] \
  || die "guest must use a dedicated primary group named guest"
getent group | awk -F: -v gid="${guest_gid}" '$3 == gid { count++ } END { exit count == 1 ? 0 : 1 }' \
  || die "guest primary GID must not be shared with another group"
[[ $(id -G guest) == "${guest_gid}" ]] \
  || die "guest must not belong to supplementary groups"
audit_guest_sudo_boundary

if (( legacy_outbox_migration_required == 1 )); then
  quiesce_legacy_outbox_worker
  labgate_acquire_lock || die "could not acquire lifecycle lock for legacy outbox migration"
  labgate_migrate_legacy_outbox \
    || die "legacy outbox migration failed closed; keep the machine drained and follow the recovery runbook"
  labgate_inventory_outbox \
    || die "post-migration webhook outbox validation failed"
  (( LABGATE_LEGACY_OUTBOX_COUNT == 0 \
    && LABGATE_LEGACY_OUTBOX_MIGRATION_COUNT == 0 )) \
    || die "legacy webhook outbox migration did not reach a terminal state"
fi

for allow_file in /etc/cron.allow /etc/at.allow; do
  remove_exact_policy_entry "${allow_file}" guest
done
for deny_file in /etc/cron.deny /etc/at.deny; do
  ensure_deny_policy_entry "${deny_file}" guest
done
rm -f -- /var/spool/cron/crontabs/guest /var/spool/cron/guest
for spool_directory in \
  /var/spool/at /var/spool/atjobs /var/spool/cron/atjobs /var/spool/cron/atspool; do
  if [[ -d ${spool_directory} && ! -L ${spool_directory} ]]; then
    find "${spool_directory}" -xdev -type f -user guest -delete
  fi
done

timeout --signal=KILL 5 loginctl disable-linger guest >/dev/null 2>&1 || true
rm -f -- /var/lib/systemd/linger/guest \
  || die "could not remove persistent guest linger marker"
[[ ! -e /var/lib/systemd/linger/guest && ! -L /var/lib/systemd/linger/guest ]] \
  || die "persistent guest linger marker remains"

visudo -cf "${SCRIPT_DIRECTORY}/sudoers-guest-provision" >/dev/null
install -o root -g root -m 0600 \
  "${SCRIPT_DIRECTORY}/labgate-common.sh" "${COMMON_INSTALL_DIRECTORY}/labgate-common.sh"
for script in guest-account.sh guest-boot-lock.sh guest-cleanup.sh guest-heartbeat.sh guest-session-hook.sh guest-webhook-flush.sh; do
  install -o root -g root -m 0700 \
    "${SCRIPT_DIRECTORY}/${script}" "/usr/local/sbin/${script}"
done
install -o root -g root -m 0755 \
  "${SCRIPT_DIRECTORY}/labgate-deny-guest-account-change.sh" \
  /usr/local/sbin/labgate-deny-guest-account-change.sh
install -o root -g root -m 0755 \
  "${SCRIPT_DIRECTORY}/labgate-provisioner-dispatch.sh" /usr/local/sbin/labgate-provisioner-dispatch.sh
install -o root -g root -m 0440 \
  "${SCRIPT_DIRECTORY}/sudoers-guest-provision" /etc/sudoers.d/labgate-guest-provision
visudo -cf /etc/sudoers.d/labgate-guest-provision >/dev/null
audit_guest_sudo_boundary

# Only expose /bin/sh after the dispatcher, sudo allow-list, effective Match
# policy, and live daemon configuration are all in place. Any earlier failure
# leaves nologin installed.
install_sshd_policy
activate_sshd_policy
chsh --shell /bin/sh provisioner \
  || die "could not enable the provisioner service shell after SSH hardening"
[[ $(getent passwd provisioner | awk -F: '{ print $7 }') == /bin/sh ]] \
  || die "provisioner service shell is not /bin/sh"
account_password_is_locked provisioner \
  || die "provisioner password lock was lost while enabling its service shell"

for unit in \
  guest-boot-lock.service guest-cleanup.service guest-cleanup.timer \
  guest-heartbeat.service guest-heartbeat.timer \
  guest-webhook-flush.service guest-webhook-flush.timer; do
  install -o root -g root -m 0644 \
    "${SCRIPT_DIRECTORY}/${unit}" "/etc/systemd/system/${unit}"
done

for config_path in \
  "${CONFIG_DIRECTORY}/api-url" "${CONFIG_DIRECTORY}/password-length" \
  "${CONFIG_DIRECTORY}/pam-file" "${CONFIG_DIRECTORY}/auth-failure-backends" \
  "${CONFIG_DIRECTORY}/ssh-host-key-sha256"; do
  [[ ! -L ${config_path} ]] || die "unsafe configuration symlink: ${config_path}"
done
printf '%s\n' "${api_url}" >"${CONFIG_DIRECTORY}/api-url"
printf '%s\n' "${password_length}" >"${CONFIG_DIRECTORY}/password-length"
chown root:root "${CONFIG_DIRECTORY}/api-url" "${CONFIG_DIRECTORY}/password-length"
chmod 0600 "${CONFIG_DIRECTORY}/api-url" "${CONFIG_DIRECTORY}/password-length"

# Secure the shared account before PAM, Tailscale, registration, or SSH setup
# can fail. On an already-configured host the RemainAfterExit unit is active,
# so --now does not interrupt a legitimate physical session during an update.
systemctl daemon-reload
systemctl enable --now guest-boot-lock.service

pam_file=$(select_pam_file)
[[ -f ${pam_file} ]] || die "display-manager PAM file does not exist: ${pam_file}"
for candidate_pam_file in /etc/pam.d/*; do
  [[ ${candidate_pam_file} == "${pam_file}" ]] && continue
  remove_known_pam_hooks "${candidate_pam_file}"
done
prepend_unique_line "${pam_file}" "${PAM_HOOK_LINE}" "${LEGACY_PAM_HOOK_LINE}"
prepend_unique_line "${pam_file}" "${PAM_PROVISIONER_DENY_LINE}"
[[ $(grep -Fxc "${PAM_HOOK_LINE}" "${pam_file}") == 1 ]] \
  || die "display-manager PAM hook was not installed exactly once"
! grep -Fqx "${LEGACY_PAM_HOOK_LINE}" "${pam_file}" \
  || die "legacy display-manager PAM hook remains installed"
install_alternate_display_manager_denials "${pam_file}"
pam_auth_visited=()
fingerprint_status=0
pam_auth_stack_contains_module "${pam_file}" pam_fprintd.so || fingerprint_status=$?
case "${fingerprint_status}" in
  0)
    die "selected password PAM stack includes pam_fprintd.so; configure a password-only stack for LabGate"
    ;;
  1) ;;
  *) die "could not validate the selected password PAM include graph" ;;
esac
auth_failure_backends=()
for auth_failure_module in pam_faillock.so pam_tally2.so pam_tally.so; do
  pam_auth_visited=()
  auth_failure_status=0
  pam_auth_stack_contains_module "${pam_file}" "${auth_failure_module}" \
    || auth_failure_status=$?
  case "${auth_failure_status}" in
    0)
      auth_failure_backend=${auth_failure_module#pam_}
      auth_failure_backend=${auth_failure_backend%.so}
      require_command "${auth_failure_backend}"
      auth_failure_backends+=("${auth_failure_backend}")
      ;;
    1) ;;
    *) die "could not validate ${auth_failure_module} in the selected PAM include graph" ;;
  esac
done
if (( ${#auth_failure_backends[@]} == 0 )); then
  auth_failure_backends_value=none
else
  auth_failure_backends_value=$(IFS=,; printf '%s' "${auth_failure_backends[*]}")
fi
printf '%s\n' "${pam_file}" >"${CONFIG_DIRECTORY}/pam-file"
printf '%s\n' "${auth_failure_backends_value}" \
  >"${CONFIG_DIRECTORY}/auth-failure-backends"
chown root:root \
  "${CONFIG_DIRECTORY}/pam-file" "${CONFIG_DIRECTORY}/auth-failure-backends"
chmod 0600 \
  "${CONFIG_DIRECTORY}/pam-file" "${CONFIG_DIRECTORY}/auth-failure-backends"
for denied_pam_file in /etc/pam.d/login /etc/pam.d/su /etc/pam.d/su-l; do
  if [[ -f ${denied_pam_file} && ! -L ${denied_pam_file} ]]; then
    prepend_unique_line "${denied_pam_file}" "${PAM_GUEST_DENY_LINE}"
    prepend_unique_line "${denied_pam_file}" "${PAM_PROVISIONER_DENY_LINE}"
  fi
done
for account_change_pam_file in /etc/pam.d/chfn /etc/pam.d/chsh; do
  [[ -f ${account_change_pam_file} && ! -L ${account_change_pam_file} ]] \
    || die "unsafe or missing account-change PAM file: ${account_change_pam_file}"
  prepend_unique_line \
    "${account_change_pam_file}" "${PAM_GUEST_ACCOUNT_CHANGE_AUTH_LINE}"
done
[[ -f /etc/pam.d/passwd && ! -L /etc/pam.d/passwd ]] \
  || die "unsafe or missing account-change PAM file: /etc/pam.d/passwd"
prepend_unique_line \
  /etc/pam.d/passwd "${PAM_GUEST_ACCOUNT_CHANGE_PASSWORD_LINE}"
labgate_prepare_guest_login_authentication \
  || die "could not establish non-expiring guest aging and reset PAM failure counters"

if ! tailscale status >/dev/null 2>&1; then
  if [[ -n ${TAILSCALE_AUTH_KEY:-} ]]; then
    [[ ${TAILSCALE_AUTH_KEY} != *$'\n'* && ${TAILSCALE_AUTH_KEY} != *$'\r'* \
      && ${#TAILSCALE_AUTH_KEY} -le 512 ]] || die "TAILSCALE_AUTH_KEY is malformed"
    new_temporary_file tailscale_auth_file
    printf '%s\n' "${TAILSCALE_AUTH_KEY}" >"${tailscale_auth_file}"
    tailscale up --auth-key="file:${tailscale_auth_file}"
  else
    tailscale up
  fi
fi

tailscale_ip=$(tailscale ip -4 | sed -n '1p')
[[ ${tailscale_ip} =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "could not determine Tailscale IPv4 address"

webhook_token=
if [[ -n ${existing_webhook_token} ]]; then
  webhook_token=${existing_webhook_token}
  chown root:root "${CONFIG_DIRECTORY}/webhook-token"
  chmod 0600 "${CONFIG_DIRECTORY}/webhook-token"
else
  [[ -n ${LABGATE_REGISTRATION_SECRET:-} ]] || die "LABGATE_REGISTRATION_SECRET is required for first registration"
  register_machine "${LABGATE_REGISTRATION_SECRET}" "${ssh_host_key_sha256}"
  IFS= read -r webhook_token <"${CONFIG_DIRECTORY}/webhook-token"
fi
write_webhook_curl_config "${webhook_token}"

rm -f -- \
  /var/lib/labgate/credential-issued-at \
  /run/labgate/guest-mounted-at \
  "${CONFIG_DIRECTORY}/max-ttl-seconds"
systemctl enable --now guest-cleanup.timer guest-heartbeat.timer guest-webhook-flush.timer

printf 'LabGate machine setup complete for %s (%s); password length is %s.\n' \
  "${machine_name}" "${tailscale_ip}" "${password_length}"
