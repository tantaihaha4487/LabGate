#!/bin/sh
set -eu

umask 077

script_name=${0##*/}
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dry_run=0
confirmed=0
phase=

usage() {
  cat <<EOF
Usage: ${script_name} prepare|finalize [--confirm] [--dry-run]

prepare   Stop the LabGate Compose service before endpoint decommissioning.
finalize  Remove the stopped Compose application and network without deleting
          bind-mounted data, secrets, or the repository.
EOF
}

fail() {
  printf 'LabGate Pi uninstall: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    prepare|finalize)
      [ -z "$phase" ] || fail 'prepare or finalize may be specified only once.'
      phase=$1
      ;;
    --confirm)
      confirmed=1
      ;;
    --dry-run)
      dry_run=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

[ -n "$phase" ] || {
  usage >&2
  exit 2
}

if [ "$dry_run" -eq 1 ]; then
  case "$phase" in
    prepare)
      printf 'Would run: docker compose stop labgate\n'
      ;;
    finalize)
      printf 'Would run: docker compose down\n'
      ;;
  esac
  exit 0
fi

[ "$confirmed" -eq 1 ] || fail 'refusing to change the Pi without --confirm.'
command -v docker >/dev/null 2>&1 || fail 'docker is required.'
docker compose version >/dev/null 2>&1 \
  || fail 'the Docker Compose plugin is required.'

cd "$repository_root"

case "$phase" in
  prepare)
    docker compose stop labgate
    printf 'LabGate is stopped. Decommission every lab endpoint before finalize.\n'
    ;;
  finalize)
    docker compose down
    printf 'LabGate Compose application removed; repository, data, secrets, and backups were preserved.\n'
    ;;
esac
