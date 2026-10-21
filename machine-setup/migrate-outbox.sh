#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
die() { printf 'migrate-outbox: %s\n' "$1" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die "root is required"
source "${SCRIPT_DIRECTORY}/labgate-common.sh"
quiesce_legacy_outbox_worker() {
  local active_state enabled_state load_state unit

  # A failed migration must not reboot into the old clock-ordered worker. Leave
  # both triggers disabled until a later, explicitly invoked installation completes.
  systemctl disable --now \
    guest-webhook-flush.path guest-webhook-flush.timer >/dev/null 2>&1 || true
  systemctl stop guest-webhook-flush.service >/dev/null 2>&1 || true
  for unit in guest-webhook-flush.path guest-webhook-flush.timer; do
    enabled_state=$(systemctl is-enabled "${unit}" 2>/dev/null || true)
    case "${enabled_state}" in
      disabled|masked|not-found) ;;
      *) die "${unit} remains enabled or its enablement state is unknown" ;;
    esac
  done
  for unit in \
    guest-webhook-flush.path guest-webhook-flush.timer guest-webhook-flush.service; do
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

quiesce_legacy_outbox_worker
labgate_acquire_lock || die "could not acquire lifecycle lock"
labgate_guest_home_mode_change_is_drained || die "machine must be fully drained and locked"
labgate_migrate_legacy_outbox || die "migration failed closed; preserve state and keep delivery stopped"
labgate_inventory_outbox || die "postflight validation failed"
(( LABGATE_LEGACY_OUTBOX_COUNT == 0 && LABGATE_LEGACY_OUTBOX_MIGRATION_COUNT == 0 )) || die "legacy records remain"
printf 'Outbox migration complete. Delivery triggers remain stopped; install the Go helpers next.\n'
