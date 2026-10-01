#!/usr/bin/env bash
# Restore a dump produced by scripts/backup.sh (or the pg-backup sidecar).
#   ./scripts/restore.sh ./data/backups/capka-20260619T120000Z.sql.gz
# DESTRUCTIVE: the current database is replaced by the dump. It stops everything
# that writes to the database first and leaves it stopped: whatever image boots
# next migrates the restored schema forward, so starting it is your call (see
# docs/UPGRADE.md for a rollback, docs/DEPLOY.md for a restore on a new host).
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

DUMP="${1:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "usage: $0 <path-to-capka-*.sql.gz>" >&2
  exit 2
fi

# pg_dump writes this line last. A dump without it was cut short (pg_dump died,
# the disk filled up) and would restore only part of the data.
if ! TAIL="$(gunzip -c "$DUMP" | tail -n 20)"; then
  echo "Refusing to restore: $DUMP is not a readable gzip file." >&2
  exit 1
fi
case "$TAIL" in
  *"PostgreSQL database dump complete"*) ;;
  *) echo "Refusing to restore: $DUMP is incomplete (no end-of-dump marker)." >&2; exit 1 ;;
esac

echo "This will OVERWRITE the Capka database with $DUMP."
printf "Type 'yes' to continue: "
read -r CONFIRM
[ "$CONFIRM" = "yes" ] || { echo "aborted"; exit 1; }

# The backup overlay is named so a running pg-backup sidecar is stopped too;
# stopping a service that has no container is a no-op.
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.backup.yml"
echo "Stopping platform, sandbox-controller and pg-backup ..."
$COMPOSE stop platform sandbox-controller pg-backup

# Restore into empty schemas, never over the live ones: --clean cannot drop a
# table that a newer release's table references, so restoring an older dump over
# a newer schema would leave a mix of both. The drop and the restore run as one
# transaction, so any error rolls back to the database as it was.
echo "Restoring ..."
{
  echo 'SET client_min_messages = warning;'
  echo 'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
  gunzip -c "$DUMP"
} | $COMPOSE exec -T postgres psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U Capka -d Capka >/dev/null || {
  echo "Restore failed (error above) and was rolled back: the database is as it was. Capka is still stopped." >&2
  echo "Start it again with:  $COMPOSE start platform sandbox-controller pg-backup" >&2
  exit 1
}

echo "Restore complete. Capka is still stopped."
echo "Next:"
echo "  - same version as before:  $COMPOSE start platform sandbox-controller pg-backup"
echo "  - rolling back a release:  CAPKA_BRANCH=v<previous> ./scripts/update.sh   (docs/UPGRADE.md)"
echo "Starting a newer image than the dump's migrates the database forward on boot."
