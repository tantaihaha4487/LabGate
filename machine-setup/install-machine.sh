#!/usr/bin/env bash
set -euo pipefail
set +x

export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

readonly REPOSITORY_OWNER=tantaihaha4487
readonly REPOSITORY_NAME=LabGate
readonly DEFAULT_REF=main
readonly EXPECTED_ENROLLMENT_VERSION=1
readonly EXPECTED_HEALTH_JSON='{"ok":true,"service":"labgate","machineEnrollmentVersion":1}'
readonly EXPECTED_REGISTRATION_JSON='{"ok":true,"service":"labgate","machineEnrollmentVersion":1,"registrationReady":true}'
readonly PROVISIONER_HOME=/var/lib/labgate-provisioner
readonly PROVISIONER_SYSUSERS=/etc/sysusers.d/labgate-provisioner.conf
readonly CONFIG_DIRECTORY=/etc/labgate

dry_run=0
local_source=0
requested_commit=
runtime_directory=
source_directory=
source_revision=
registration_secret=
tailscale_auth_key=
provided_registration_secret=${LABGATE_REGISTRATION_SECRET:-}
provided_tailscale_auth_key=${TAILSCALE_AUTH_KEY:-}
unset LABGATE_REGISTRATION_SECRET TAILSCALE_AUTH_KEY MACHINE_REGISTRATION_SECRET 2>/dev/null || true

style_reset=
style_heading=
style_label=
style_success=
style_warning=
style_child=
stderr_style_reset=
stderr_style_error=
stderr_style_warning=
prompt_style_reset=
prompt_style_label=
prompt_style_warning=
color_mode=auto
color_suppressed=0
stdout_style_used=0
stderr_style_used=0
prompt_style_used=0
current_stage=0
current_stage_title=
failure_reported=0
failure_recovery=guide

cleanup() {
  registration_secret=
  tailscale_auth_key=
  provided_registration_secret=
  provided_tailscale_auth_key=
  unset LABGATE_REGISTRATION_SECRET TAILSCALE_AUTH_KEY 2>/dev/null || true
  case "${runtime_directory}" in
    /tmp/labgate-install.*)
      [[ ! -d ${runtime_directory} ]] || rm -rf -- "${runtime_directory}"
      ;;
  esac
  reset_terminal_styles
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

die() {
  printf '%binstall-machine: ERROR: %s%b\n' \
    "${stderr_style_error}" "$1" "${stderr_style_reset}" >&2
  [[ -z ${stderr_style_error} ]] || stderr_style_used=1
  if (( current_stage > 0 && failure_reported == 0 )); then
    print_stage_failure
  fi
  exit 1
}

initialize_terminal_styles() {
  color_mode=${LABGATE_INSTALL_COLOR:-auto}

  case "${color_mode}" in
    auto|always|never) ;;
    *)
      printf 'install-machine: ERROR: LABGATE_INSTALL_COLOR must be auto, always, or never\n' >&2
      exit 1
      ;;
  esac

  if [[ ${NO_COLOR+x} || ${TERM:-dumb} == dumb || ${color_mode} == never ]]; then
    color_suppressed=1
    return 0
  fi

  if [[ ${color_mode} == always || -t 1 ]]; then
    style_reset=$'\033[0m'
    style_heading=$'\033[1;36m'
    style_label=$'\033[1;34m'
    style_success=$'\033[1;32m'
    style_warning=$'\033[1;33m'
    style_child=$'\033[2m'
  fi
  if [[ ${color_mode} == always || -t 2 ]]; then
    stderr_style_reset=$'\033[0m'
    stderr_style_error=$'\033[1;31m'
    stderr_style_warning=$'\033[1;33m'
  fi
}

initialize_prompt_styles() {
  prompt_style_reset=
  prompt_style_label=
  prompt_style_warning=
  (( color_suppressed == 0 )) || return 0
  if [[ ${color_mode} == always || -t 3 ]]; then
    prompt_style_reset=$'\033[0m'
    prompt_style_label=$'\033[1;34m'
    prompt_style_warning=$'\033[1;33m'
  fi
}

reset_terminal_styles() {
  if (( stdout_style_used == 1 )); then
    printf '%b' $'\033[0m'
  fi
  if (( stderr_style_used == 1 )); then
    printf '%b' $'\033[0m' >&2
  fi
  if (( prompt_style_used == 1 )) && exec 3<>/dev/tty 2>/dev/null; then
    printf '%b' $'\033[0m' >&3
    exec 3>&-
  fi
}

print_heading() {
  printf '\n%b%s%b\n' "${style_heading}" "$1" "${style_reset}"
  [[ -z ${style_heading} ]] || stdout_style_used=1
}

print_success_heading() {
  printf '\n%b%s%b\n' "${style_success}" "$1" "${style_reset}"
  [[ -z ${style_success} ]] || stdout_style_used=1
}

print_preview_row() {
  printf '%b%-20s%b %s\n' "${style_label}" "$1" "${style_reset}" "$2"
  [[ -z ${style_label} ]] || stdout_style_used=1
}

print_completion_row() {
  printf '%b%-24s%b %s\n' "${style_label}" "$1" "${style_reset}" "$2"
  [[ -z ${style_label} ]] || stdout_style_used=1
}

print_stage() {
  current_stage=$1
  current_stage_title=$2
  printf '\n%b[%s/8]%b %s\n' \
    "${style_heading}" "$1" "${style_reset}" "$2"
  [[ -z ${style_heading} ]] || stdout_style_used=1
}

print_stage_success() {
  printf '%b[OK] %s%b\n' "${style_success}" "$1" "${style_reset}"
  [[ -z ${style_success} ]] || stdout_style_used=1
}

print_input_error() {
  printf '%bInvalid value: %s%b\n' \
    "${stderr_style_error}" "$1" "${stderr_style_reset}" >&2
  [[ -z ${stderr_style_error} ]] || stderr_style_used=1
}

documentation_url() {
  local revision=${source_revision:-${DEFAULT_REF}}

  [[ ${revision} =~ ^[0-9a-f]{40}$ ]] || revision=${DEFAULT_REF}
  printf 'https://github.com/%s/%s/blob/%s/docs/recovery.md#physical-acceptance\n' \
    "${REPOSITORY_OWNER}" "${REPOSITORY_NAME}" "${revision}"
}

print_stage_failure() {
  failure_reported=1
  printf '\n%b[ERROR] Stage %s/8 failed: %s.%b\n' \
    "${stderr_style_error}" "${current_stage}" "${current_stage_title}" \
    "${stderr_style_reset}" >&2
  printf '%bRequired operator action%b\n' \
    "${stderr_style_warning}" "${stderr_style_reset}" >&2
  if [[ ${failure_recovery} == heartbeat ]]; then
    printf '  sudo systemctl status guest-heartbeat.service --no-pager\n' >&2
    printf '  sudo journalctl -u guest-heartbeat.service -n 100 --no-pager\n' >&2
    printf '  After correcting the cause: sudo systemctl start guest-heartbeat.service\n' >&2
  else
    printf '  Recovery guide: %s\n' "$(documentation_url)" >&2
  fi
  printf '%bDo not allow student use until recovery and physical acceptance pass.%b\n' \
    "${stderr_style_warning}" "${stderr_style_reset}" >&2
  if [[ -n ${stderr_style_error}${stderr_style_warning} ]]; then
    stderr_style_used=1
  fi
}

print_completion_summary() {
  local host_key_pin=$1

  print_success_heading 'LabGate machine installation complete'
  print_completion_row 'Machine:' "${machine_summary}"
  print_completion_row 'Pi enrollment API:' \
    "healthy; protocol v${EXPECTED_ENROLLMENT_VERSION}"
  if (( fresh_install == 1 )); then
    print_completion_row 'Registration access:' 'accepted'
  else
    print_completion_row 'Registered identity:' 'preserved'
  fi
  print_completion_row 'Tailscale address:' "${tailscale_ip}"
  print_completion_row 'SSH host-key pin:' "${host_key_pin}"
  print_completion_row 'Provisioner key:' "${key_fingerprint}"
  print_completion_row 'Guest account:' 'locked'
  print_completion_row 'Lifecycle timers:' 'enabled and active'
  print_completion_row 'Initial heartbeat:' 'local service completed'
  printf '\n%bRequired operator actions%b\n' \
    "${style_warning}" "${style_reset}"
  [[ -z ${style_warning} ]] || stdout_style_used=1
  printf '  1. Confirm the LabGate dashboard shows this machine as available.\n'
  printf '  2. Complete physical login, active-session, logout, cleanup, and expiry checks.\n'
  printf '  3. Record the evidence before allowing student use.\n'
  printf '%bManual shell commands:%b none; the initial heartbeat service already ran.\n' \
    "${style_label}" "${style_reset}"
  printf '%bChecklist:%b %s\n' \
    "${style_label}" "${style_reset}" "$(documentation_url)"
  [[ -z ${style_label} ]] || stdout_style_used=1
}

redact_child_output() {
  local line

  while IFS= read -r line || [[ -n ${line} ]]; do
    if [[ -n ${registration_secret} ]]; then
      line=${line//"${registration_secret}"/'[REDACTED]'}
    fi
    if [[ -n ${tailscale_auth_key} ]]; then
      line=${line//"${tailscale_auth_key}"/'[REDACTED]'}
    fi
    printf '%s\n' "${line}"
  done
}

render_child_output() {
  if [[ -n ${style_child} ]]; then
    redact_child_output \
      | LC_ALL=C sed -u -E \
        -e $'s/\033\\][^\a]*(\a|\033\\\\)//g' \
        -e $'s/\033\\[[0-?]*[ -\\/]*[@-~]//g' \
        -e $'s/\033[@-_]//g' \
        -e $'s/[\001-\010\013-\037\177]//g' \
        -e $'s/^/\033[2m| /' \
        -e $'s/$/\033[0m/'
  else
    redact_child_output \
      | LC_ALL=C sed -u -E \
        -e $'s/\033\\][^\a]*(\a|\033\\\\)//g' \
        -e $'s/\033\\[[0-?]*[ -\\/]*[@-~]//g' \
        -e $'s/\033[@-_]//g' \
        -e $'s/[\001-\010\013-\037\177]//g' \
        -e 's/^/| /'
  fi
}

run_child_command() {
  local command_status renderer_status had_errexit=0
  local -a pipeline_status

  [[ $- != *e* ]] || had_errexit=1
  [[ -z ${style_child} ]] || stdout_style_used=1
  set +e
  "$@" 2>&1 | render_child_output
  pipeline_status=("${PIPESTATUS[@]}")
  command_status=${pipeline_status[0]}
  renderer_status=${pipeline_status[1]}
  (( had_errexit == 0 )) || set -e
  (( renderer_status == 0 )) \
    || die "could not safely render child-command output"
  return "${command_status}"
}

usage() {
  cat <<'EOF'
Usage: install-machine.sh [--dry-run] [--local | --commit SHA]

Interactively installs or updates a physical Ubuntu or Arch-family Desktop
LabGate endpoint.

Options:
  --dry-run       Validate inputs and print the installation preview only.
  --local         Use the machine-setup directory containing this script.
  --commit SHA    Download machine-side assets from one exact Git commit.
  -h, --help      Show this help text.

Fresh enrollment prompts for the Pi API origin, machine name, password length,
registration secret, optional Tailscale auth key, and the Pi's Ed25519
provisioner public key. Secrets are read from /dev/tty without echo. Color is
enabled automatically on a terminal and disabled when output is redirected or
NO_COLOR is set.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

new_runtime_file() {
  local destination_name=$1 path

  path=$(mktemp "${runtime_directory}/file.XXXXXX") \
    || die "could not create a private temporary file"
  chmod 0600 "${path}"
  printf -v "${destination_name}" '%s' "${path}"
}

prompt_value() {
  local destination_name=$1 label=$2 default_value=${3:-} value

  [[ ${LABGATE_INSTALL_NONINTERACTIVE:-0} != 1 ]] \
    || die "${label} was not supplied for non-interactive execution"
  if ! exec 3<>/dev/tty 2>/dev/null; then
    die "${label} requires a terminal; rerun from an administrator terminal"
  fi
  initialize_prompt_styles
  if [[ -n ${default_value} ]]; then
    printf '%b%s%b [%s]: ' \
      "${prompt_style_label}" "${label}" "${prompt_style_reset}" \
      "${default_value}" >&3
  else
    printf '%b%s%b: ' \
      "${prompt_style_label}" "${label}" "${prompt_style_reset}" >&3
  fi
  [[ -z ${prompt_style_label} ]] || prompt_style_used=1
  IFS= read -r value <&3 || die "could not read ${label}"
  exec 3>&-
  if [[ -z ${value} ]]; then
    value=${default_value}
  fi
  printf -v "${destination_name}" '%s' "${value}"
}

prompt_validated_value() {
  local destination_name=$1 label=$2 default_value=$3 validator=$4 error_message=$5 value

  while true; do
    prompt_value value "${label}" "${default_value}"
    if "${validator}" "${value}"; then
      printf -v "${destination_name}" '%s' "${value}"
      return
    fi
    print_input_error "${error_message}"
  done
}

prompt_secret() {
  local destination_name=$1 label=$2 optional=${3:-0} value

  [[ ${LABGATE_INSTALL_NONINTERACTIVE:-0} != 1 ]] \
    || die "${label} was not supplied for non-interactive execution"
  if ! exec 3<>/dev/tty 2>/dev/null; then
    die "${label} requires a terminal; rerun from an administrator terminal"
  fi
  initialize_prompt_styles
  if (( optional == 1 )); then
    printf '%b%s%b (optional; press Enter to skip): ' \
      "${prompt_style_label}" "${label}" "${prompt_style_reset}" >&3
  else
    printf '%b%s%b: ' \
      "${prompt_style_label}" "${label}" "${prompt_style_reset}" >&3
  fi
  [[ -z ${prompt_style_label} ]] || prompt_style_used=1
  IFS= read -r -s value <&3 || die "could not read ${label}"
  printf '\n' >&3
  exec 3>&-
  printf -v "${destination_name}" '%s' "${value}"
}

prompt_registration_secret() {
  while true; do
    prompt_secret registration_secret 'Machine registration secret'
    if labgate_validate_registration_secret "${registration_secret}"; then
      return
    fi
    registration_secret=
    print_input_error 'registration secret must be a 20-256 character RFC 6750 b64token'
  done
}

validate_machine_name() {
  [[ $1 =~ ^[A-Za-z0-9._\ -]{1,64}$ ]]
}

validate_password_length() {
  [[ $1 =~ ^[0-9]{1,3}$ ]] \
    && (( 10#$1 >= 8 && 10#$1 <= 128 ))
}

validate_public_key_line() {
  local key_data key_type line=$1 remainder

  (( ${#line} >= 32 && ${#line} <= 16384 )) || return 1
  [[ ${line} != *[[:cntrl:]]* ]] || return 1
  [[ ${line} == 'ssh-ed25519 '* ]] || return 1
  IFS=' ' read -r key_type key_data remainder <<<"${line}"
  [[ ${key_type} == ssh-ed25519 \
    && ${key_data} =~ ^[A-Za-z0-9+/]+={0,3}$ ]]
}

validate_public_key_file_shape() {
  local extra key_file=$1 line

  exec 4<"${key_file}" || return 1
  if ! IFS= read -r line <&4; then
    if [[ -z ${line} ]]; then
      exec 4>&-
      return 1
    fi
  fi
  if IFS= read -r extra <&4 || [[ -n ${extra} ]]; then
    exec 4>&-
    return 1
  fi
  exec 4>&-
  validate_public_key_line "${line}"
}

public_key_fingerprint() {
  local bits fingerprint key_file=$1 output type

  output=$(ssh-keygen -lf "${key_file}" -E sha256 2>/dev/null) || return 1
  [[ -n ${output} && ${output} != *$'\n'* ]] || return 1
  bits=$(awk '{ print $1 }' <<<"${output}")
  fingerprint=$(awk '{ print $2 }' <<<"${output}")
  type=$(awk '{ print $NF }' <<<"${output}")
  [[ ${bits} == 256 && ${type} == '(ED25519)' \
    && ${fingerprint} =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || return 1
  printf '%s\n' "${fingerprint}"
}

validate_source_tree() {
  local file
  local -a required_files=(
    00-labgate-deny-guest.rules
    guest-account.sh
    guest-boot-lock.service
    guest-boot-lock.sh
    guest-cleanup.service
    guest-cleanup.sh
    guest-cleanup.timer
    guest-heartbeat.service
    guest-heartbeat.sh
    guest-heartbeat.timer
    guest-session-hook.sh
    guest-webhook-flush.service
    guest-webhook-flush.sh
    guest-webhook-flush.timer
    install-machine.sh
    labgate-common.sh
    labgate-platform.sh
    labgate-deny-guest-account-change.sh
    labgate-guest.conf
    labgate-provisioner.conf
    labgate-provisioner-dispatch.sh
    setup-machine.sh
    sshd-labgate-guest.conf
    sudoers-guest-provision
  )

  for file in "${required_files[@]}"; do
    [[ -f ${source_directory}/${file} && ! -L ${source_directory}/${file} ]] \
      || die "source archive is missing a safe machine-side artifact: ${file}"
  done
  for file in \
    guest-account.sh guest-boot-lock.sh guest-cleanup.sh guest-heartbeat.sh \
    guest-session-hook.sh guest-webhook-flush.sh install-machine.sh \
    labgate-common.sh labgate-platform.sh setup-machine.sh; do
    bash -n "${source_directory}/${file}" \
      || die "source archive contains invalid Bash syntax: ${file}"
  done
  sh -n "${source_directory}/labgate-provisioner-dispatch.sh" \
    || die "source archive contains an invalid provisioner dispatcher"
  sh -n "${source_directory}/labgate-deny-guest-account-change.sh" \
    || die "source archive contains an invalid account-change guard"
}

stage_source_tree() {
  local api_response archive extracted_root

  if (( local_source == 1 )); then
    source_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
    source_revision='local checkout'
    validate_source_tree
    return
  fi

  require_command curl
  require_command tar
  require_command sed
  if [[ -n ${requested_commit} ]]; then
    source_revision=${requested_commit}
  else
    new_runtime_file api_response
    curl --fail --silent --show-error \
      --proto '=https' --tlsv1.2 \
      --connect-timeout 5 --max-time 20 \
      --output "${api_response}" \
      --url "https://api.github.com/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/commits/${DEFAULT_REF}" \
      || die "could not resolve ${DEFAULT_REF} to an immutable Git commit"
    source_revision=$(sed -n \
      's/^[[:space:]]*"sha":[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' \
      "${api_response}" | sed -n '1p')
    [[ ${source_revision} =~ ^[0-9a-f]{40}$ ]] \
      || die "GitHub did not return a canonical commit SHA"
  fi

  new_runtime_file archive
  mkdir -m 0700 "${runtime_directory}/source"
  curl --fail --silent --show-error \
    --proto '=https' --tlsv1.2 \
    --connect-timeout 5 --max-time 60 \
    --output "${archive}" \
    --url "https://codeload.github.com/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/tar.gz/${source_revision}" \
    || die "could not download the reviewed LabGate source archive"
  tar -xzf "${archive}" -C "${runtime_directory}/source" --no-same-owner \
    || die "could not extract the LabGate source archive"
  extracted_root=$(find "${runtime_directory}/source" \
    -mindepth 1 -maxdepth 1 -type d -print -quit)
  [[ -n ${extracted_root} ]] || die "LabGate source archive has no root directory"
  source_directory=${extracted_root}/machine-setup
  validate_source_tree
}

read_safe_config_default() {
  local destination_name=$1 fallback=$3 path=$2 value

  if [[ -e ${path} || -L ${path} ]]; then
    [[ -f ${path} && ! -L ${path} ]] || die "unsafe existing configuration: ${path}"
    if [[ ${EUID} -eq 0 ]]; then
      [[ $(stat -c '%u' -- "${path}") == 0 ]] \
        || die "existing configuration is not root-owned: ${path}"
      IFS= read -r value <"${path}" || die "could not read ${path}"
      printf -v "${destination_name}" '%s' "${value}"
      return
    fi
  fi
  printf -v "${destination_name}" '%s' "${fallback}"
}

default_machine_name() {
  local value

  if [[ -r /proc/sys/kernel/hostname ]]; then
    IFS= read -r value </proc/sys/kernel/hostname \
      || die "could not read the kernel hostname"
  else
    require_command hostname
    value=$(hostname -s) || die "could not determine the hostname"
  fi
  value=${value%%.*}
  [[ -n ${value} ]] || die "the machine hostname is empty"
  printf '%s\n' "${value}"
}

provisioner_authorized_keys_path() {
  local home record

  if record=$(getent passwd provisioner 2>/dev/null); then
    IFS=: read -r _ _ _ _ _ home _ <<<"${record}"
    [[ -n ${home} && ${home} != /home/guest ]] || return 1
  else
    home=${PROVISIONER_HOME}
  fi
  printf '%s/.ssh/authorized_keys\n' "${home}"
}

install_ubuntu_dependencies() {
  local package
  local -a packages=(
    ca-certificates coreutils curl findutils grep hostname keyutils
    libpam-modules libpam-modules-bin login mawk openssh-client
    openssh-server passwd policykit-1 procps sudo systemd systemd-sysv tar
    util-linux
  )

  require_command apt-get
  run_child_command env DEBIAN_FRONTEND=noninteractive apt-get update \
    || die "apt package-index refresh failed"
  run_child_command env DEBIAN_FRONTEND=noninteractive \
    apt-get install -y --no-install-recommends "${packages[@]}" \
    || die "Ubuntu prerequisite installation failed"
  for package in curl getent hostname keyctl nologin passwd pkaction sshd \
    ssh-keygen systemctl systemd-sysusers timedatectl visudo; do
    require_command "${package}"
  done
}

install_arch_dependencies() {
  local package
  local -a packages=(
    bash ca-certificates coreutils curl findutils gawk glibc grep gzip
    inetutils keyutils openssh pam polkit procps-ng sed shadow sudo systemd
    tailscale tar util-linux
  )

  require_command pacman
  # Arch does not support partial upgrades. Refreshing package databases and
  # installing prerequisites therefore happens as one full system upgrade.
  run_child_command pacman -Syu --needed --noconfirm "${packages[@]}" \
    || die "Arch full upgrade and prerequisite installation failed"
  for package in curl getent hostname keyctl nologin passwd pkaction sshd \
    ssh-keygen systemctl systemd-sysusers tailscale timedatectl visudo; do
    require_command "${package}"
  done
}

install_platform_dependencies() {
  case "${os_family}" in
    ubuntu) install_ubuntu_dependencies ;;
    arch) install_arch_dependencies ;;
    *) die "internal unsupported platform selection: ${os_family}" ;;
  esac
}

ensure_clock_and_ssh() {
  local synchronized

  run_child_command sshd -t || die "OpenSSH configuration is invalid"
  if systemctl list-unit-files ssh.service >/dev/null 2>&1; then
    systemctl enable --now ssh.service >/dev/null
  elif systemctl list-unit-files sshd.service >/dev/null 2>&1; then
    systemctl enable --now sshd.service >/dev/null
  else
    die "OpenSSH Server did not install an SSH service"
  fi

  synchronized=$(timedatectl show --property=NTPSynchronized --value 2>/dev/null || true)
  if [[ ${synchronized} != yes ]]; then
    timedatectl set-ntp true >/dev/null 2>&1 || true
    for _ in {1..30}; do
      synchronized=$(timedatectl show --property=NTPSynchronized --value 2>/dev/null || true)
      [[ ${synchronized} == yes ]] && break
      sleep 1
    done
  fi
  [[ ${synchronized} == yes ]] \
    || die "system clock did not become NTP-synchronized within 30 seconds"
}

ensure_tailscale() {
  local tailscale_installer tailscale_key_file

  if ! command -v tailscale >/dev/null 2>&1; then
    new_runtime_file tailscale_installer
    curl --fail --silent --show-error \
      --proto '=https' --tlsv1.2 \
      --connect-timeout 5 --max-time 60 \
      --output "${tailscale_installer}" \
      --url https://tailscale.com/install.sh \
      || die "could not download the official Tailscale installer"
    run_child_command sh "${tailscale_installer}" \
      || die "the official Tailscale installer failed"
  fi
  require_command tailscale
  systemctl enable --now tailscaled.service >/dev/null \
    || die "could not start tailscaled.service"

  if ! tailscale_is_connected; then
    if [[ -n ${tailscale_auth_key} ]]; then
      [[ ${tailscale_auth_key} != *$'\n'* && ${tailscale_auth_key} != *$'\r'* \
        && ${#tailscale_auth_key} -le 512 ]] \
        || die "Tailscale auth key is malformed"
      new_runtime_file tailscale_key_file
      printf '%s\n' "${tailscale_auth_key}" >"${tailscale_key_file}"
      run_child_command tailscale up --auth-key="file:${tailscale_key_file}" \
        || die "Tailscale authentication failed"
      : >"${tailscale_key_file}"
    else
      run_child_command tailscale up \
        || die "interactive Tailscale authentication failed"
    fi
  fi
  tailscale_auth_key=
  unset TAILSCALE_AUTH_KEY 2>/dev/null || true
  tailscale_is_connected \
    || die "Tailscale is installed but not connected to the tailnet"
}

validate_tailscale_ipv4() {
  local ip=$1
  local -a octets

  IFS=. read -r -a octets <<<"${ip}"
  (( ${#octets[@]} == 4 )) || return 1
  [[ ${octets[0]} == 100 \
    && ${octets[1]} =~ ^(0|[1-9][0-9]{0,2})$ \
    && ${octets[2]} =~ ^(0|[1-9][0-9]{0,2})$ \
    && ${octets[3]} =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
  (( 10#${octets[1]} >= 64 && 10#${octets[1]} <= 127 \
    && 10#${octets[2]} <= 255 && 10#${octets[3]} <= 255 ))
}

tailscale_is_connected() {
  command -v tailscale >/dev/null 2>&1 \
    && command -v timeout >/dev/null 2>&1 \
    && timeout --signal=KILL 3 tailscale status >/dev/null 2>&1
}

check_pi_health() {
  local body http_status

  new_runtime_file body
  if ! http_status=$(curl --silent --show-error \
    --connect-timeout 3 --max-time 10 --max-filesize 4096 --noproxy '*' \
    --output "${body}" --write-out '%{http_code}' \
    --url "${api_url}/api/health"); then
    die "could not reach the Pi health endpoint at ${api_url}"
  fi
  [[ ${http_status} == 200 ]] \
    || die "Pi health endpoint returned HTTP ${http_status}"
  [[ $(<"${body}") == "${EXPECTED_HEALTH_JSON}" ]] \
    || die "Pi health endpoint is not a compatible LabGate enrollment API v${EXPECTED_ENROLLMENT_VERSION}"
}

check_registration_readiness() {
  local auth_config body http_status

  labgate_validate_registration_secret "${registration_secret}" \
    || die "registration secret is not a valid 20-256 character RFC 6750 b64token"
  new_runtime_file auth_config
  new_runtime_file body
  {
    printf 'header = "Authorization: Bearer %s"\n' "${registration_secret}"
    printf 'header = "Accept: application/json"\n'
  } >"${auth_config}"
  if ! http_status=$(curl --config "${auth_config}" \
    --silent --show-error --connect-timeout 3 --max-time 10 \
    --max-filesize 4096 --noproxy '*' \
    --output "${body}" --write-out '%{http_code}' \
    --url "${api_url}/api/admin/register-machine"); then
    die "could not reach the Pi registration-readiness endpoint"
  fi
  : >"${auth_config}"
  [[ ${http_status} == 200 ]] \
    || die "Pi registration-readiness endpoint returned HTTP ${http_status}"
  [[ $(<"${body}") == "${EXPECTED_REGISTRATION_JSON}" ]] \
    || die "Pi registration-readiness response is incompatible"
}

account_password_is_locked() {
  local account=$1 reported_account status

  read -r reported_account status _ < <(passwd -S "${account}" 2>/dev/null) \
    || return 1
  [[ ${reported_account} == "${account}" && ${status} =~ ^(L|LK)$ ]]
}

verify_nologin() {
  local mode target

  target=$(readlink -f -- /usr/sbin/nologin 2>/dev/null || true)
  [[ -n ${target} && -f ${target} && ! -L ${target} && -x ${target} \
    && $(stat -c '%u' -- "${target}") == 0 ]] || return 1
  mode=$(stat -c '%a' -- "${target}") || return 1
  (( (8#${mode} & 8#022) == 0 ))
}

prepare_provisioner() {
  local gid home mode name record shell uid

  verify_nologin \
    || die "/usr/sbin/nologin is not a safe root-controlled executable"
  if ! getent passwd provisioner >/dev/null; then
    (( fresh_install == 1 )) \
      || die "existing enrollment has no provisioner identity"
    install -d -o root -g root -m 0755 /etc/sysusers.d
    install -o root -g root -m 0644 \
      "${source_directory}/labgate-provisioner.conf" "${PROVISIONER_SYSUSERS}"
    systemd-sysusers "${PROVISIONER_SYSUSERS}" \
      || die "systemd-sysusers could not create the provisioner identity"
  fi

  record=$(getent passwd provisioner) || die "provisioner identity is missing"
  IFS=: read -r name _ uid gid _ home shell <<<"${record}"
  [[ ${name} == provisioner && ${uid} != 0 && ${home} != /home/guest \
    && -n ${gid} ]] || die "provisioner identity is unsafe"
  if [[ ! -e ${home} ]]; then
    [[ ${home} == "${PROVISIONER_HOME}" ]] \
      || die "refusing to create an unexpected provisioner home"
    install -d -o root -g root -m 0755 "${home}"
  fi
  [[ -d ${home} && ! -L ${home} && $(stat -c '%u' -- "${home}") == 0 ]] \
    || die "provisioner home must be a root-owned real directory"
  mode=$(stat -c '%a' -- "${home}")
  (( (8#${mode} & 8#022) == 0 )) \
    || die "provisioner home must not be group- or world-writable"
  if (( fresh_install == 1 )); then
    [[ $(readlink -f -- "${shell}" 2>/dev/null || true) \
      == $(readlink -f -- /usr/sbin/nologin) ]] \
      || die "fresh provisioner identity must begin with nologin"
  fi
  install -d -o "${uid}" -g "${gid}" -m 0700 "${home}/.ssh"
  passwd -l provisioner >/dev/null 2>&1 \
    || die "could not lock the provisioner password"
  account_password_is_locked provisioner \
    || die "provisioner password is not locked"
  if (( fresh_install == 1 )); then
    [[ ! -e ${home}/.ssh/authorized_keys && ! -L ${home}/.ssh/authorized_keys ]] \
      || die "fresh provisioner identity already has an authorized key"
  fi
}

install_provisioner_key() {
  local authorized_keys gid home record staged uid

  record=$(getent passwd provisioner) || die "provisioner identity is missing"
  IFS=: read -r _ _ uid gid _ home _ <<<"${record}"
  authorized_keys=${home}/.ssh/authorized_keys
  [[ ! -e ${authorized_keys} && ! -L ${authorized_keys} ]] \
    || die "refusing to overwrite an existing provisioner authorized_keys file"
  staged=${home}/.ssh/.authorized_keys.labgate.$$
  [[ ! -e ${staged} && ! -L ${staged} ]] \
    || die "temporary authorized_keys path already exists"
  install -o "${uid}" -g "${gid}" -m 0600 "${public_key_file}" "${staged}"
  if ! ln -- "${staged}" "${authorized_keys}"; then
    rm -f -- "${staged}"
    die "could not publish the provisioner key without overwriting state"
  fi
  rm -f -- "${staged}"
  [[ -f ${authorized_keys} && ! -L ${authorized_keys} \
    && $(stat -c '%u:%g:%a' -- "${authorized_keys}") == "${uid}:${gid}:600" ]] \
    || die "installed provisioner key has unsafe metadata"
}

verify_existing_provisioner_key() {
  local authorized_keys=$1 gid home mode owner record uid

  record=$(getent passwd provisioner) || die "provisioner identity is missing"
  IFS=: read -r _ _ uid gid _ home _ <<<"${record}"
  [[ ${authorized_keys} == "${home}/.ssh/authorized_keys" \
    && -f ${authorized_keys} && ! -L ${authorized_keys} ]] \
    || die "existing provisioner key path is unsafe"
  owner=$(stat -c '%u' -- "${authorized_keys}")
  mode=$(stat -c '%a' -- "${authorized_keys}")
  [[ ${owner} == 0 || ${owner} == "${uid}" ]] \
    || die "existing provisioner key must be root- or provisioner-owned"
  (( (8#${mode} & 8#077) == 0 )) \
    || die "existing provisioner key must not be accessible by group or world"
  public_key_fingerprint "${authorized_keys}" >/dev/null \
    || die "existing provisioner key is not one Ed25519 key"
}

run_hardened_setup() {
  export LABGATE_API_URL=${api_url}
  export LABGATE_MACHINE_NAME=${machine_name}
  export LABGATE_PASSWORD_LENGTH=${password_length}
  export NO_PROXY='*'
  export no_proxy='*'
  unset LABGATE_PAM_FILE LABGATE_MIGRATE_LEGACY_OUTBOX 2>/dev/null || true
  if (( fresh_install == 1 )); then
    export LABGATE_REGISTRATION_SECRET=${registration_secret}
  else
    unset LABGATE_REGISTRATION_SECRET 2>/dev/null || true
  fi
  run_child_command bash "${source_directory}/setup-machine.sh" \
    || die "hardened LabGate machine setup failed"
  registration_secret=
  unset LABGATE_REGISTRATION_SECRET 2>/dev/null || true
}

verify_installation() {
  local unit

  account_password_is_locked guest || die "guest is not locked after installation"
  systemctl is-active --quiet guest-boot-lock.service \
    || die "guest-boot-lock.service is not active"
  for unit in \
    guest-cleanup.timer guest-heartbeat.timer guest-webhook-flush.timer; do
    systemctl is-enabled --quiet "${unit}" \
      || die "${unit} is not enabled"
    systemctl is-active --quiet "${unit}" \
      || die "${unit} is not active"
  done
  if ! run_child_command systemctl start guest-heartbeat.service; then
    failure_recovery=heartbeat
    die "initial safe heartbeat service failed"
  fi
}

initialize_terminal_styles

while (( $# > 0 )); do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    --local)
      local_source=1
      ;;
    --commit)
      shift
      (( $# > 0 )) || die "--commit requires a 40-character SHA"
      requested_commit=$1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
  shift
done

(( local_source == 0 || ${#requested_commit} == 0 )) \
  || die "--local and --commit are mutually exclusive"
if [[ -n ${requested_commit} ]]; then
  [[ ${requested_commit} =~ ^[0-9a-f]{40}$ ]] \
    || die "--commit must be one lowercase 40-character Git SHA"
fi
if (( dry_run == 0 && EUID != 0 )); then
  die "must run as root; pipe the installer to sudo bash"
fi

runtime_directory=$(mktemp -d "/tmp/labgate-install.XXXXXX") \
  || die "could not create a private runtime directory"
chmod 0700 "${runtime_directory}"
stage_source_tree

# shellcheck source=labgate-common.sh
source "${source_directory}/labgate-common.sh" \
  || die "could not load the reviewed LabGate validation library"
# shellcheck source=labgate-platform.sh
source "${source_directory}/labgate-platform.sh" \
  || die "could not load the reviewed LabGate platform library"

[[ -r /etc/os-release ]] || die "could not identify the operating system"
# shellcheck source=/etc/os-release
unset ID ID_LIKE PRETTY_NAME 2>/dev/null || true
source /etc/os-release
os_family=$(labgate_classify_platform "${ID:-}" "${ID_LIKE:-}" || true)
case "${os_family}" in
  ubuntu)
    os_support='Ubuntu Desktop confirmed'
    os_family_label='Ubuntu'
    dependency_plan='Install the fixed Ubuntu prerequisites and verify clock/SSH.'
    ;;
  arch)
    os_support="${PRETTY_NAME:-Arch Linux} (Arch family) confirmed"
    os_family_label='Arch'
    dependency_plan='Fully upgrade Arch packages, install fixed prerequisites, and verify clock/SSH.'
    ;;
  *)
    os_family=unsupported
    os_family_label='unsupported'
    dependency_plan='Unsupported host; no package operation is available.'
    ;;
esac
if [[ ${os_family} == unsupported ]]; then
  if (( dry_run == 0 )); then
    die "the one-shot installer supports Ubuntu and Arch-family desktops only"
  fi
  os_support="unsupported ${PRETTY_NAME:-${ID:-unknown}}; real installation would stop"
fi
fresh_install=1
if [[ -e ${CONFIG_DIRECTORY}/webhook-token || -L ${CONFIG_DIRECTORY}/webhook-token ]]; then
  [[ -f ${CONFIG_DIRECTORY}/webhook-token && ! -L ${CONFIG_DIRECTORY}/webhook-token ]] \
    || die "existing webhook identity is unsafe"
  [[ -s ${CONFIG_DIRECTORY}/webhook-token ]] \
    || die "existing webhook identity is empty"
  fresh_install=0
fi

read_safe_config_default existing_api_url \
  "${CONFIG_DIRECTORY}/api-url" ''
read_safe_config_default existing_password_length \
  "${CONFIG_DIRECTORY}/password-length" '8'
api_url=${LABGATE_API_URL:-}
machine_name=${LABGATE_MACHINE_NAME:-$(default_machine_name)}
password_length=${LABGATE_PASSWORD_LENGTH:-}
if [[ -n ${api_url} ]]; then
  labgate_validate_api_origin "${api_url}" \
    || die "Pi API must be a canonical origin-only HTTP(S) URL"
else
  prompt_validated_value api_url 'Pi LabGate API origin' "${existing_api_url}" \
    labgate_validate_api_origin \
    'enter a canonical origin such as https://raspberrypi.example.ts.net without spaces or a trailing slash'
fi
if (( fresh_install == 1 )) && [[ ! ${LABGATE_MACHINE_NAME+x} ]]; then
  prompt_validated_value machine_name 'Unique machine name' "${machine_name}" \
    validate_machine_name \
    'machine name must be 1-64 characters using letters, numbers, spaces, dot, underscore, or hyphen'
fi
validate_machine_name "${machine_name}" \
  || die "machine name contains unsupported characters"
if [[ -n ${password_length} ]]; then
  validate_password_length "${password_length}" \
    || die "guest password length must be between 8 and 128"
else
  prompt_validated_value password_length \
    'Guest password length (8-128; normally 8)' "${existing_password_length}" \
    validate_password_length \
    'guest password length must be a whole number between 8 and 128; use 8 unless the Pi is configured differently'
fi
if (( fresh_install == 1 )); then
  registration_secret=${provided_registration_secret}
  provided_registration_secret=
  if [[ -n ${registration_secret} ]]; then
    labgate_validate_registration_secret "${registration_secret}" \
      || die "registration secret is not a valid 20-256 character RFC 6750 b64token"
  else
    prompt_registration_secret
  fi
fi
provided_registration_secret=

tailscale_state='already connected'
tailscale_auth_key=${provided_tailscale_auth_key}
provided_tailscale_auth_key=
if [[ -n ${tailscale_auth_key} ]]; then
  if tailscale_is_connected; then
    tailscale_state='already connected; supplied auth key will not be used'
  else
    tailscale_state='installation or tailnet login required; auth key supplied (hidden)'
  fi
elif ! tailscale_is_connected; then
  tailscale_state='installation or tailnet login required'
  prompt_secret tailscale_auth_key 'Tailscale auth key' 1
  if [[ -n ${tailscale_auth_key} ]]; then
    tailscale_state='installation or tailnet login required; auth key supplied (hidden)'
  fi
fi
authorized_keys=$(provisioner_authorized_keys_path) \
  || die "could not determine the provisioner authorized_keys path"
needs_public_key=0
if [[ -e ${authorized_keys} || -L ${authorized_keys} ]]; then
  [[ -f ${authorized_keys} && ! -L ${authorized_keys} ]] \
    || die "provisioner authorized_keys path is unsafe"
  (( fresh_install == 0 )) \
    || die "fresh enrollment requires a provisioner identity with no authorized key"
  public_key_file=${authorized_keys}
else
  needs_public_key=1
  public_key_file=${LABGATE_PROVISIONER_PUBLIC_KEY_FILE:-}
  if [[ -n ${public_key_file} ]]; then
    [[ -f ${public_key_file} && ! -L ${public_key_file} ]] \
      || die "provisioner public-key input file is unsafe"
  else
    while true; do
      prompt_value public_key_line 'Paste the Pi provisioner Ed25519 public key'
      if validate_public_key_line "${public_key_line}"; then
        break
      fi
      public_key_line=
      print_input_error 'paste exactly one plain ssh-ed25519 public-key line from the Pi'
    done
    new_runtime_file public_key_file
    printf '%s\n' "${public_key_line}" >"${public_key_file}"
    public_key_line=
  fi
fi

key_fingerprint='validation follows prerequisite installation'
if command -v ssh-keygen >/dev/null 2>&1; then
  validate_public_key_file_shape "${public_key_file}" \
    || die "provisioner public key must be one plain ssh-ed25519 key"
  key_fingerprint=$(public_key_fingerprint "${public_key_file}") \
    || die "provisioner public key must be one valid Ed25519 key"
fi

if (( fresh_install == 1 )); then
  install_mode='Fresh enrollment'
  registration_summary='supplied (hidden)'
  machine_summary=${machine_name}
else
  install_mode='Safe update; registered identity unchanged'
  registration_summary='not required for an existing identity'
  machine_summary='existing registered endpoint (name unchanged)'
fi
print_heading 'LabGate physical machine installer'
print_preview_row 'Mode:' "${install_mode}"
print_preview_row 'Source revision:' "${source_revision}"
print_preview_row 'Target OS:' "${os_support}"
print_preview_row 'Machine:' "${machine_summary}"
print_preview_row 'Pi API:' "${api_url}"
print_preview_row 'Pi preflight:' 'health and enrollment compatibility will be checked'
print_preview_row 'Password length:' "${password_length}"
print_preview_row 'Tailscale:' "${tailscale_state}"
print_preview_row 'Provisioner key:' "${key_fingerprint}"
print_preview_row 'Registration key:' "${registration_summary}"
print_heading 'Planned changes'
printf '  1. %s\n' "${dependency_plan}"
printf '  2. Connect this endpoint to Tailscale.\n'
printf '  3. Verify the Pi health endpoint and enrollment protocol v%s.\n' \
  "${EXPECTED_ENROLLMENT_VERSION}"
if (( fresh_install == 1 )); then
  printf '  4. Authenticate registration readiness without changing Pi data.\n'
fi
printf '  5. Apply the reviewed guest, PAM, Polkit, sudoers, SSH, and timer policy.\n'
if (( needs_public_key == 1 )); then
  printf '  6. Publish the provisioner key only after hardened setup succeeds.\n'
fi

if (( dry_run == 1 )); then
  printf '\n%bDry run complete;%b no host or Pi state was changed.\n' \
    "${style_success}" "${style_reset}"
  [[ -z ${style_success} ]] || stdout_style_used=1
  exit 0
fi

[[ ${LABGATE_INSTALL_NONINTERACTIVE:-0} != 1 ]] \
  || die "interactive confirmation is required for a real installation"
if ! exec 3<>/dev/tty 2>/dev/null; then
  die "interactive confirmation requires an administrator terminal"
fi
initialize_prompt_styles
printf '\n%bContinue? [y/N]:%b ' \
  "${prompt_style_warning}" "${prompt_style_reset}" >&3
[[ -z ${prompt_style_warning} ]] || prompt_style_used=1
IFS= read -r confirmation <&3 || die "could not read confirmation"
exec 3>&-
case "${confirmation}" in
  y|Y|yes|YES|Yes) ;;
  *) die "installation cancelled" ;;
esac

print_stage 1 "Installing ${os_family_label} prerequisites"
install_platform_dependencies
validate_public_key_file_shape "${public_key_file}" \
  || die "provisioner public key must be one plain ssh-ed25519 key"
key_fingerprint=$(public_key_fingerprint "${public_key_file}") \
  || die "provisioner public key must be one valid Ed25519 key"
if [[ ${os_family} == ubuntu ]]; then
  print_stage_success 'Ubuntu prerequisites installed.'
else
  print_stage_success 'Arch prerequisites installed and the full upgrade completed.'
fi

print_stage 2 'Verifying clock synchronization and administrator SSH'
ensure_clock_and_ssh
print_stage_success 'Clock synchronized; administrator SSH is active and valid.'

print_stage 3 'Connecting the endpoint to Tailscale'
ensure_tailscale
tailscale_ip=$(timeout --signal=KILL 5 tailscale ip -4 | sed -n '1p')
validate_tailscale_ipv4 "${tailscale_ip}" \
  || die "Tailscale did not assign one canonical CGNAT IPv4 address"
print_stage_success "Tailscale connected at ${tailscale_ip}."

print_stage 4 'Checking the Pi health and enrollment endpoints'
check_pi_health
print_stage_success "Pi enrollment API is healthy; protocol v${EXPECTED_ENROLLMENT_VERSION}."
if (( fresh_install == 1 )); then
  check_registration_readiness
  print_stage_success 'Registration access accepted.'
else
  print_stage_success 'Existing registration identity preserved.'
fi

print_stage 5 'Preparing the locked provisioner boundary'
prepare_provisioner
if (( needs_public_key == 0 )); then
  verify_existing_provisioner_key "${authorized_keys}"
fi
print_stage_success 'Locked provisioner boundary prepared.'

print_stage 6 'Applying the hardened LabGate machine setup'
run_hardened_setup
print_stage_success 'Guest, PAM, Polkit, sudoers, SSH, and timer policy applied.'

print_stage 7 'Publishing the key last and sending a safe heartbeat'
if (( needs_public_key == 1 )); then
  install_provisioner_key
fi
verify_installation
if (( needs_public_key == 1 )); then
  print_stage_success 'Provisioner key published; initial safe heartbeat service completed.'
else
  print_stage_success 'Provisioner key preserved; initial safe heartbeat service completed.'
fi

print_stage 8 'Verifying the Pi endpoint after installation'
check_pi_health
print_stage_success "Pi endpoint remains healthy; protocol v${EXPECTED_ENROLLMENT_VERSION}."

print_completion_summary "$(<"${CONFIG_DIRECTORY}/ssh-host-key-sha256")"
