#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
npm --prefix web ci
npm --prefix web run build
mkdir -p bin dist
for program in labgate labgate-migrate labgate-machine; do
  CGO_ENABLED=0 go build -trimpath -o "bin/${program}" "./cmd/${program}"
done
for arch in amd64 arm64; do
  release="dist/labgate-linux-${arch}"
  mkdir -p "${release}/machine-setup"
  for program in labgate labgate-migrate labgate-machine; do
    GOOS=linux GOARCH="${arch}" CGO_ENABLED=0 go build -trimpath -o "${release}/${program}" "./cmd/${program}"
  done
  cp machine-setup/* "${release}/machine-setup/"
  for helper in guest-account guest-boot-lock guest-cleanup guest-heartbeat guest-session-hook guest-webhook-flush labgate-provisioner-dispatch labgate-deny-guest-account-change; do
    ln -f "${release}/labgate-machine" "${release}/machine-setup/${helper}.sh"
  done
  cp scripts/install.sh "${release}/install.sh"
  cp -r docs "${release}/docs"
  cp README.md "${release}/README.md"
  (cd "${release}" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
  tar -C dist -czf "dist/labgate-linux-${arch}.tar.gz" "labgate-linux-${arch}"
done
printf 'Ready: bin/ and dist/labgate-linux-{amd64,arm64}.tar.gz\n'
