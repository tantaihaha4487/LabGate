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
  if [[ ${id} == arch ]]; then
    printf '%s\n' arch
    return 0
  fi

  read -r -a id_like_tokens <<<"${id_like}"
  for token in "${id_like_tokens[@]}"; do
    if [[ ${token} == arch ]]; then
      printf '%s\n' arch
      return 0
    fi
  done
  return 1
}
