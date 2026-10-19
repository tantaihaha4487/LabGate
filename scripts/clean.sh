#!/usr/bin/env bash
set -euo pipefail
project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
dry_run=0
with_deps=0
usage() {
  printf '%s\n' \
    'Usage: ./scripts/clean.sh [--dry-run] [--deps]' \
    'Remove project build output, frontend caches, and test reports.' \
    '  --dry-run  Show what would be removed.' \
    '  --deps     Also remove web/node_modules.' \
    'Source files, databases, secrets, backups, and Go caches are retained.'
}
for argument in "$@"; do
  case "${argument}" in
    --dry-run) dry_run=1 ;;
    --deps) with_deps=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "${argument}" >&2; usage >&2; exit 2 ;;
  esac
done
paths=(
  bin dist web/dist web/dist-ssr web/.vite
  web/node_modules/.vite web/node_modules/.tmp
  test-results web/test-results web/playwright-report
)
if (( with_deps )); then paths+=(web/node_modules); fi
# Validate every parent before removing anything. Never traverse a symlink
# into a dependency directory or frontend tree outside this checkout.
for relative in "${paths[@]}"; do
  parent=${relative%/*}
  [[ ${parent} != "${relative}" ]] || continue
  while [[ ${parent} != . ]]; do
    if [[ -L ${project_root}/${parent} ]]; then
      printf 'Refusing to clean through symlink: %s\n' "${parent}" >&2
      exit 1
    fi
    [[ ${parent} == */* ]] || break
    parent=${parent%/*}
  done
done
for relative in "${paths[@]}"; do
  target=${project_root}/${relative}
  [[ -e ${target} || -L ${target} ]] || continue
  if (( dry_run )); then
    printf 'Would remove: %s\n' "${relative}"
  else
    rm -rf -- "${target}"
    printf 'Removed: %s\n' "${relative}"
  fi
done
if (( ! dry_run )); then
  printf 'Clean complete. Rebuild frontend assets before Go builds: npm --prefix web run build\n'
fi
