# Development

Use the Docker dev stack for day-to-day work:

```bash
npm run docker:dev
```

It starts the app, Postgres, the sandbox controller, the Docker socket proxy, and
the sandbox image with development defaults. Open <http://localhost:3000> and
create the admin account.

## Commands

```bash
npm run dev            # Next.js dev server; requires DATABASE_URL
npm run docker:dev     # full local stack with build overlay
npm run up             # create missing .env secrets, then start production stack
npm run docker:prod    # start production compose stack
npm run docker:down    # stop the stack
npm run sandbox:build  # rebuild the sandbox image
npm test               # Vitest unit tests
```

## Notes

- `docker-compose.yml` is the production stack and pulls release images
- `docker-compose.dev.yml` adds local development behavior
- `docker-compose.build.yml` builds images from source
- `docker-compose.tls.yml` adds Caddy HTTPS when `DOMAIN` is set
- `docker-compose.backup.yml` adds a scheduled Postgres backup sidecar

Restart the platform container after editing worker, runner, instrumentation, or
Telegram bot code. HMR does not reload the in-process worker.

For production deploys, use [`DEPLOY.md`](DEPLOY.md).

## Cutting a release (maintainers)

Pushing the tag IS the deploy: `stable` moves to the release and the public demo
redeploys itself. Decide that before you tag, not after.

1. On a clean `master`, run `scripts/release-gate.sh`. It must end on its final
   `RELEASE GATE:` line; a report without it is an aborted run, so treat it as a failure.
2. `npm run release <x.y.z|patch|minor|major>` bumps `package.json`, turns
   `[Unreleased]` in `CHANGELOG.md` into the dated section, commits
   `chore(release): cut vX.Y.Z` and tags it. It refuses a dirty tree and never pushes.
3. `git push origin master vX.Y.Z` starts `publish-images.yml`.

What the tag run does, in order:

- The `gate` job refuses to publish unless CI passed for the tagged commit. It waits
  up to 90 minutes for a run in progress. If master never finished a run for that
  commit (a newer push cancelled it), the gate starts CI on the tag itself, once.
  To start it by hand (the workflow has `workflow_dispatch`), then re-run the failed
  publish run:
  `gh workflow run ci.yml --ref vX.Y.Z`
- A prerelease tag (`vX.Y.Z-rc.N`) publishes only its own image tag. A plain
  `vX.Y.Z` also moves `vX.Y`, `vX`, and, only as the newest release overall,
  `latest`, `stable` and the GitHub Release. An older maintenance tag never rolls a
  channel back.
- Images build per architecture, merge into one manifest, then `stable` moves, then
  the GitHub Release is published last. Do not run `gh release create` by hand.

After the release, regenerate the upgrade-path fixture against the NEW tag and commit it
(`src/lib/__tests__/fixtures/last-release.sql`). It needs a Postgres where the user may
CREATE DATABASE, and a `pg_dump` no newer than CI's Postgres (17):

```bash
DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/postgres \
PG_DUMP="docker exec unclaw-postgres-1 pg_dump" \
node scripts/upgrade-fixture.mjs vX.Y.Z
```

