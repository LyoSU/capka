#!/usr/bin/env sh
# Restore a dump produced by scripts/backup.sh into the running database.
#   ./scripts/restore.sh ./data/backups/unclaw-20260619T120000Z.sql.gz
# DESTRUCTIVE: the dump is taken with --clean --if-exists, so it drops and
# recreates objects. Stop the platform first so the worker doesn't write mid-restore.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

DUMP="${1:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "usage: $0 <path-to-unclaw-*.sql.gz>" >&2
  exit 2
fi

echo "This will OVERWRITE the unClaw database with $DUMP."
printf "Type 'yes' to continue: "
read -r CONFIRM
[ "$CONFIRM" = "yes" ] || { echo "aborted"; exit 1; }

echo "Stopping platform to quiesce the worker ..."
docker compose stop platform

echo "Restoring ..."
gunzip -c "$DUMP" | docker compose exec -T postgres psql -U unClaw -d unClaw

echo "Restarting platform ..."
docker compose start platform
echo "Restore complete."
