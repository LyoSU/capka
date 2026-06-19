#!/usr/bin/env sh
# Dump the unClaw Postgres database to ./data/backups/unclaw-<timestamp>.sql.gz.
# Runs pg_dump inside the postgres container, so no local psql client is needed.
#   ./scripts/backup.sh
# Postgres is the system of record AND the task queue, so this one dump is the
# complete backup. Keep these files off-box for real disaster recovery.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

OUT_DIR="${BACKUP_DIR:-./data/backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/unclaw-$STAMP.sql.gz"

echo "Dumping unClaw database to $OUT_FILE ..."
docker compose exec -T postgres pg_dump -U unClaw -d unClaw --clean --if-exists \
  | gzip > "$OUT_FILE"

echo "Done: $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"

# Prune dumps older than RETENTION_DAYS (default 14; 0 disables pruning).
RETENTION_DAYS="${RETENTION_DAYS:-14}"
if [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$OUT_DIR" -name 'unclaw-*.sql.gz' -mtime "+$RETENTION_DAYS" -delete
fi
