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

1. On a clean `master`, run `scripts/release-gate.sh` by hand; `npm run release` does
   not run it. Tag only when it ends on `RELEASE GATE: PASS - the tree is fit to tag.`
   and exits 0. `RELEASE GATE: FAIL` is a failure, and a report with no final
   `RELEASE GATE:` line is an aborted run: also a failure.
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
- Every tag runs the whole workflow, but what it moves depends on the tag:
  - A plain `vX.Y.Z` always publishes its own image tag. It also moves `vX.Y` when it
    is the newest release of that minor, and `vX` when it is the newest of that major
    (never for `v0.`). Only as the newest plain release overall does it also move
    `latest` and the `stable` branch, and its GitHub Release gets the latest mark.
  - A plain tag that is not the newest overall (an older maintenance release) moves
    only the moving tags it is newest of, never `latest` or `stable`. Its GitHub
    Release is still published, with `--latest=false`.
  - A prerelease tag (`vX.Y.Z-rc.N`) publishes only its own image tag, moves nothing
    else, and gets a GitHub prerelease with `--latest=false`.
  Either way `/releases/latest` (the in-app update banner) never returns an older or
  prerelease tag.
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

