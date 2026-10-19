#!/usr/bin/env bash

# Pure platform classification shared by the one-shot installer and its tests.
# ID and ID_LIKE come from the host's trusted /etc/os-release file.

labgate_classify_platform() {
  local id=${1:-} id_like=${2:-} token
  local -a id_like_tokens=()

  if [[ ${id} == ubuntu ]]; then
    printf '%s\n' ubuntu
    return 0
  fi
  if [[ ${id} == debian || ${id} == raspbian ]]; then
    printf '%s\n' debian
    return 0
  fi
  if [[ ${id} == arch ]]; then
    printf '%s\n' arch
    return 0
  fi

  read -r -a id_like_tokens <<<"${id_like}"
  for token in "${id_like_tokens[@]}"; do
    if [[ ${token} == debian ]]; then
      printf '%s\n' debian
      return 0
    fi
    if [[ ${token} == arch ]]; then
      printf '%s\n' arch
      return 0
    fi
  done
  return 1
}

# list-unit-files exits successfully even when the requested unit is absent.
labgate_sshd_unit() {
  local unit
  for unit in ssh.service sshd.service; do
    if [[ $(systemctl show "${unit}" --property=LoadState --value 2>/dev/null) == loaded ]]; then
      printf '%s\n' "${unit}"
      return 0
    fi
  done
  return 1
}

# Debian splits timesyncd out of systemd. Preserve an existing NTP provider.
labgate_needs_timesyncd() {
  local provider
  for provider in systemd-timesyncd chrony ntpsec ntp openntpd; do
    if [[ $(dpkg-query -W -f='${Status}' "${provider}" 2>/dev/null) == 'install ok installed' ]]; then
      return 1
    fi
  done
  return 0
}
