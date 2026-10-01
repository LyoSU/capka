# Upgrading Capka

Capka runs database migrations **automatically on platform boot** from the
`drizzle/` SQL files baked into the image. Migrations are forward-only: an older
image does not undo them.

## Standard upgrade

In the install directory (`/opt/capka` for the installer):

```bash
sudo ./scripts/backup.sh && sudo ./scripts/update.sh
```

`backup.sh` dumps the database to `./data/backups/`; the `&&` stops the update if
the dump fails. `update.sh` checks out the newest release, pins its images in
`.env` (`CAPKA_VERSION`) and hands off to `up.sh`, which pulls them and recreates
the stack. To go to one specific release instead:
`sudo CAPKA_BRANCH=vX.Y.Z ./scripts/update.sh`.

Re-running `up.sh` alone does not upgrade: it re-applies the version already
pinned in `.env`. The database dump is not a complete backup — see
[Backup & restore](DEPLOY.md#backup--restore) for `.env` and `./data/storage`, and
for bringing the scheduled-backup sidecar back after an update.

### Did the migration work?

The healthcheck does not tell you: it probes `/login`, and a failed migration
leaves the platform serving and healthy while it retries in the background.
Read the log instead:

```bash
docker compose logs platform | grep '\[db\]'
```

- `[db] migrations up to date` — the schema is current.
- `[db] auto-migration failed (continuing; retrying in the background)` or
  `[db] auto-migration retry failed: …` — the schema is NOT current; the error
  after it says why. Fix the cause or roll back (below).

## Rollback

Rolling the image back does **not** roll the schema back, and the newer image
re-applies its migrations every time it boots. So the database has to be
restored while nothing runs, and the next thing to start must be the previous
release:

```bash
# 1. Stops platform, sandbox-controller and pg-backup, restores the dump taken
#    before the upgrade, and leaves them stopped.
sudo ./scripts/restore.sh ./data/backups/capka-<taken-before-the-upgrade>.sql.gz

# 2. Checks out the previous release, pins its images and starts it.
sudo CAPKA_BRANCH=v<previous> ./scripts/update.sh
```

Do not `docker compose start`/`up` between the two steps: the newer image would
migrate the restored database forward again. Run step 1 from the current
checkout — older releases ship a `restore.sh` that restores over the live schema
and restarts the platform itself.

Anything written after the dump was taken is lost. Keep the pre-upgrade dump
until the new version is verified.

## Downtime

A single-host compose deploy has a brief gap while the platform container is
recreated.
