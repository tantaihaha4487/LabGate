#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
command -v podman >/dev/null || { printf 'Podman is required for disposable distro checks.\n' >&2; exit 1; }
[[ -x bin/labgate && -x bin/labgate-migrate ]] || { printf 'Run scripts/build.sh first.\n' >&2; exit 1; }
temporary=$(mktemp -d /tmp/labgate-platform-check.XXXXXX)
trap 'rm -rf -- "${temporary}"' EXIT
CGO_ENABLED=0 go test -c -o "${temporary}/machine-tests" ./internal/machine
for image in debian:12-slim debian:13-slim archlinux:latest; do
  podman run --rm -v "${PWD}:/work:ro" -v "${temporary}/machine-tests:/machine-tests:ro" "docker.io/library/${image}" bash /work/tests/container-platform.sh
done
