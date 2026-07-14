#!/bin/sh
set -eu

umask 077

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
database_path="$repository_root/data/labgate.db"
backup_directory="$repository_root/backups"

fail() {
  printf 'LabGate database save failed: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail 'docker is required.'
command -v sqlite3 >/dev/null 2>&1 || fail 'sqlite3 is required.'
[ -f "$database_path" ] || fail "database does not exist: $database_path"

install -d -m 700 "$backup_directory"
cd "$repository_root"
docker compose version >/dev/null 2>&1 || fail 'the Docker Compose plugin is required.'
docker compose stop labgate

timestamp=$(date -u +%Y%m%d-%H%M%S)
backup_path="$backup_directory/labgate-before-remove-$timestamp.db"
if [ -e "$backup_path" ] || [ -L "$backup_path" ]; then
  fail "backup already exists: $backup_path"
fi

sqlite3 "$database_path" ".backup '$backup_path'"
chmod 600 "$backup_path"

integrity_result=$(sqlite3 "$backup_path" 'PRAGMA integrity_check;')
[ "$integrity_result" = 'ok' ] || fail "SQLite integrity check returned: $integrity_result"

foreign_key_result=$(sqlite3 "$backup_path" 'PRAGMA foreign_key_check;')
[ -z "$foreign_key_result" ] || fail "SQLite foreign-key check returned: $foreign_key_result"

printf 'Verified database backup: %s\n' "$backup_path"
printf 'The labgate service remains stopped. Review the backup before running docker compose down.\n'
