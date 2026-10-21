#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
npm --prefix web run build
go test -race ./...
go vet ./...
npm --prefix web run lint
npm --prefix web test
for file in scripts/*.sh machine-setup/*.sh; do bash -n "${file}"; done
bash tests/platform_test.sh
if go list -deps ./cmd/labgate ./cmd/labgate-machine | rg -q '^labgate/internal/migration$'; then
  printf 'Application binaries must not link the migration package.\n' >&2
  exit 1
fi
git diff --check
