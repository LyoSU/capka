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
the dump fails. `update.sh` checks out the newest release of the major version
you run now, pins its images in `.env` (`CAPKA_VERSION`) and hands off to `up.sh`,
which pulls them and recreates the stack. To go to one specific release instead:
`sudo CAPKA_BRANCH=vX.Y.Z ./scripts/update.sh`.

Re-running `up.sh` alone does not upgrade: it re-applies the version already
pinned in `.env`. The database dump is not a complete backup — see
[Backup & restore](DEPLOY.md#backup--restore) for `.env` and `./data`, and
for bringing the scheduled-backup sidecar back after an update.

### New major versions and prereleases

`update.sh` does not move to a new major version (for example 0.x to 1.0) or to a
prerelease (`vX.Y.Z-rc.N`) on its own. When a newer major exists it prints a note
and stays on the one you run; Settings → Updates announces the new major all the
same. Given a newer major as `CAPKA_BRANCH` (a tag, or `stable` pointing at one),
or a prerelease, it refuses. Read that release's notes first, then:

```bash
# the newest release, whatever its major
sudo CAPKA_ALLOW_MAJOR=1 ./scripts/update.sh
# one prerelease (add CAPKA_ALLOW_MAJOR=1 too if it starts a new major)
sudo CAPKA_ALLOW_PRERELEASE=1 CAPKA_BRANCH=vX.Y.Z-rc.N ./scripts/update.sh
```

Re-running the installer has neither guard: it moves an existing install to the
newest tag of any major, a prerelease included. Upgrade with `update.sh`.

### Did the migration work?

The healthcheck does not tell you: it probes `/login`, and a failed migration
leaves the platform serving and healthy while it retries in the background.
Read the log instead:

```bash
docker compose logs platform | grep -E 'migrations up to date|auto-migration'
```

The **last** of these lines decides:

- `[db] migrations up to date` — the schema is current. A failure line before it
  only means an earlier attempt failed (often Postgres was still starting) and a
  retry succeeded.
- `[db] auto-migration failed (continuing; retrying in the background)` or
  `[db] auto-migration retry failed: …` — the schema is NOT current; the error
  after it says why. Fix the cause or roll back (below).
- `[db] could not start auto-migration (continuing without it)` — the schema is
  NOT current and nothing retries. Fix the cause and restart the platform.

The other `[db]` lines (`carried … legacy memory doc(s)`, `memory-doc migration
failed`) belong to a data migration that runs after the schema is current; they
do not change the answer.

## Rollback

Rolling the image back does **not** roll the schema back, and the newer image
re-applies its migrations every time it boots. So the database has to be
restored while nothing runs, and the next thing to start must be the previous
release:

```bash
# 1. Stops platform, sandbox-controller and pg-backup, restores the dump taken
#    before the upgrade, and leaves them stopped.
sudo ./scripts/restore.sh ./data/backups/capka-<taken-before-the-upgrade>.sql.gz

# 2. Restarts the workspaces' idle clocks, which came back from the dump
#    (DEPLOY.md, Restore); otherwise the controller may delete live workspaces.
sudo docker compose exec -T postgres psql -X -U Capka -d Capka \
  -c 'UPDATE sandbox_sessions SET last_activity = (extract(epoch from now()) * 1000)::bigint'

# 3. Checks out the previous release, pins its images and starts it.
sudo CAPKA_BRANCH=v<previous> ./scripts/update.sh
```

Do not `docker compose start`/`up` before step 3: the newer image would
migrate the restored database forward again. Step 1 needs the `restore.sh` of a
release newer than v0.42.0; v0.42.0 and earlier ship one that restores over the
live schema and restarts the platform itself. On such a checkout swap the script
in first, or, while no release after v0.42.0 exists, restore by hand
([Restore](DEPLOY.md#restore) has both).

Anything written after the dump was taken is lost. Keep the pre-upgrade dump
until the new version is verified.

## Downtime

A single-host compose deploy has a brief gap while the platform container is
recreated.
