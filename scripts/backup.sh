#!/usr/bin/env bash
# Dump the Capka Postgres database to ./data/backups/capka-<timestamp>.sql.gz.
# Runs pg_dump inside the postgres container, so no local psql client is needed.
#   ./scripts/backup.sh
# The dump covers the database only. A complete backup also needs .env
# (CAPKA_MASTER_KEY decrypts the provider keys and secrets stored in the dump)
# and ./data/storage (users' files) — see docs/DEPLOY.md "Backup & restore".
# Dumps hold session tokens and password hashes: they are written 0600, and
# copies kept off-box should be encrypted.
set -euo pipefail
umask 077
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

OUT_DIR="${BACKUP_DIR:-./data/backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/capka-$STAMP.sql.gz"
# Written to a .tmp name the retention glob ignores and renamed only once pg_dump
# has exited 0, so a failed dump never looks like a backup.
trap 'rm -f "$OUT_FILE.tmp"' EXIT

echo "Dumping Capka database to $OUT_FILE ..."
docker compose exec -T postgres pg_dump -U Capka -d Capka --clean --if-exists \
  | gzip > "$OUT_FILE.tmp"
mv "$OUT_FILE.tmp" "$OUT_FILE"

echo "Done: $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"

# Prune dumps older than RETENTION_DAYS (default 14; 0 or empty disables
# pruning). Reached only after a successful dump, so failures never eat the
# good backups.
RETENTION_DAYS="${RETENTION_DAYS-14}"
if [ "${RETENTION_DAYS:-0}" -gt 0 ]; then
  find "$OUT_DIR" -name 'capka-*.sql.gz' -mtime "+$RETENTION_DAYS" -delete
fi
