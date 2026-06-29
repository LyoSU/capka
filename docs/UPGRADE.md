# Upgrading Capka

Capka runs database migrations **automatically on platform boot** from the
`drizzle/` SQL files baked into the image. Upgrades are forward-only by default.

## Standard upgrade

```bash
# 1. Back up first — migrations are forward-only.
./scripts/backup.sh

# 2. Pin the target release (or leave CAPKA_VERSION unset for latest).
echo 'CAPKA_VERSION=v0.2.0' >> .env   # edit if already present

# 3. Pull the new images and recreate. The platform migrates the DB on boot.
docker compose pull
docker compose up -d

# 4. Watch the platform come up healthy (migrations run during start_period).
docker compose logs -f platform
```

The platform healthcheck (`/login`) flips healthy once migrations finish and the
server is serving. If it stays unhealthy, check the logs for a migration error.

## Rollback

Migrations are forward-only, so rolling the image back does **not** roll the
schema back. To revert:

```bash
docker compose stop platform
./scripts/restore.sh ./data/backups/capka-<timestamp-before-upgrade>.sql.gz
echo 'CAPKA_VERSION=<previous-tag>' > /tmp/v && \
  sed -i.bak '/^CAPKA_VERSION=/d' .env && cat /tmp/v >> .env
docker compose pull && docker compose up -d
```

Always keep the pre-upgrade dump until the new version is verified.

## Zero/low-downtime note

A single-host compose deploy has a brief restart gap while the platform
recreates. For teams that need continuity, run behind the Caddy overlay (Phase B)
and accept the few-second gap, or move to the company-tier external-Postgres +
multi-replica topology (see the roadmap).
