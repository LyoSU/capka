# Deploying Capka

Capka ships as one canonical compose stack (`docker-compose.yml`) that pulls
prebuilt images. There are two supported ways to run it in production: the
one-command self-host installer, and Coolify. Both deploy the *same*
`docker-compose.yml` — the difference is only who runs `docker compose` and how
TLS is terminated.

Local development is separate: `npm run docker:dev`; see
[`DEVELOPMENT.md`](DEVELOPMENT.md).

## Compose files

| File | Role |
|---|---|
| `docker-compose.yml` | **The stack you deploy.** Pull-only (prebuilt GHCR images), internal-only Postgres/controller, platform published on `${PLATFORM_BIND:-0.0.0.0}` (set `PLATFORM_BIND=127.0.0.1` for loopback only). |
| `docker-compose.dev.yml` | Local dev overlay (hot reload, dev secrets). |
| `docker-compose.build.yml` | Build-from-source overlay (`CAPKA_BUILD=1`). |
| `docker-compose.tls.yml` | Automatic HTTPS via Caddy (`up.sh` layers it when `DOMAIN` is set). |
| `docker-compose.backup.yml` | Scheduled `pg_dump` sidecar — see [Backup & restore](#backup--restore). |

Pin a release with `CAPKA_VERSION=vX.Y.Z` in `.env`; unset ⇒ `:latest`.

Each release publishes its images as `vX.Y.Z`, `vX.Y` and `vX` (`vX` from 1.0 on:
a 0.x release has no `v0`), and as `latest` when it is the newest release
overall. `vX.Y` and `vX` move only to the newest release in that line; a
prerelease (`vX.Y.Z-rc.N`) publishes only its own tag.
`CAPKA_VERSION=v1` pulls every 1.x release and never 2.0, but it pins the images
only: use it with a compose file from a v1.x release tag, not from `stable` or
`master`, which move on to the next major. `latest` follows the newest release,
including a new major. `scripts/update.sh` writes `CAPKA_VERSION` itself and
already stays on the installed major (see [`UPGRADE.md`](UPGRADE.md)), so do not
set `v1` on an install that it updates.

Run one Capka stack per Docker daemon. The stack creates fixed-name networks
(`capka-sandbox-egress`, `capka-egress-out`), so a second stack on the same
daemon is not supported.

## Which git ref to deploy

Images are published on release tags only, so **the compose file on `master` is
always newer than any image you can pull.** A deployment that follows `master`
without building from source therefore runs new compose against the last
release's images — and a service the compose file added but the image does not
contain yet cannot start at all.

| Ref | Use it for | Images |
|---|---|---|
| `stable` | **Pull-only deployments** (Coolify, `update.sh`). CI moves it to the newest release, a new major included, after its images are published, so compose and images always match. | `:latest` |
| `vX.Y.Z` | Pinning one exact release. | that tag |
| `master` | Development tip. Requires `CAPKA_BUILD=1` — the scripts refuse to pair it with prebuilt images. | built locally |

## Path A — self-host installer (curl \| sh)

On a fresh Linux box, one command installs Docker (if missing), fetches Capka,
generates secrets, and brings the stack up with automatic HTTPS:

```bash
curl -fsSL https://raw.githubusercontent.com/LyoSU/capka/master/install.sh | DOMAIN=capka.example.com sh
```

No domain? Omit `DOMAIN` and the installer offers a free `<ip>.sslip.io`
hostname, or serves plain `:3000` to front with your own proxy. Already have a
clone: `DOMAIN=capka.example.com ./scripts/up.sh` (or `npm run up`). To upgrade in
place, run `sudo ./scripts/update.sh` in the install directory
([`UPGRADE.md`](UPGRADE.md)). Re-running the installer also upgrades, but to the
newest tag of any major, a prerelease included. Environment variables are listed in
[`.env.example`](../.env.example).

## Path B — Coolify

Coolify runs the full stack (including the Docker-socket sandbox) since it
deploys onto a host with a Docker daemon.

1. **New Resource → Docker Compose**, point it at this repo and set the branch to
   **`stable`** — not `master`. See [Which git ref to deploy](#which-git-ref-to-deploy):
   `master` carries compose changes for images that are not published yet, so a
   `master`-tracking stack breaks on the release that introduces a new service.
2. Set **docker_compose_location** to `/docker-compose.yml` (the canonical
   pull-only stack — Coolify pulls the release images, no source build).
3. Set environment variables:
   - `PUBLIC_URL` = `https://<your-domain>` — the app's public origin
     (better-auth `trustedOrigins`). Missing/wrong ⇒ `INVALID_ORIGIN` on
     login/register.
   - `CAPKA_MASTER_KEY`, `CONTROLLER_SECRET`, `POSTGRES_PASSWORD` =
     `openssl rand -hex 32` each. Keep a copy of `CAPKA_MASTER_KEY` outside
     Coolify: a restored database is unreadable without it.
   - `SETUP_TOKEN` = `openssl rand -hex 32`. Without it a deploy reachable from
     the network refuses the first-run admin claim (`/setup` answers 403). Open
     `https://<your-domain>/setup#token=<value>` to create the admin account.
   - `SANDBOX_RUNTIME` = `runc` (default). For untrusted/multi-tenant code,
     install gVisor on the host (`sudo sh scripts/install-gvisor.sh`) and set
     `runsc` — the controller then refuses to boot until gVisor is present
     (fail-closed).
   - Optional tuning (defaults in parentheses): `SANDBOX_MEMORY_MB` (1024),
     `SANDBOX_PIDS_LIMIT` (1024),
     `MAX_SESSIONS_PER_USER` (2), `SANDBOX_IDLE_TTL_MS` (900000),
     `WORKSPACE_TTL_MS` (2592000000), `GC_GRACE_MS` (604800000),
     `SANDBOX_ALLOW_NETWORK` (true), `PLATFORM_MEM_LIMIT` (4g — on a 2 GB box
     set it to about `1536m`; the platform's heap is sized at 75% of it).
   - Optional tracing (see [Tracing](#tracing-optional)):
     `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`. Paste the
     header value **unquoted**, exactly as one line — it legitimately contains
     `=` and `,` (`Authorization=Basic <base64>,x-langfuse-ingestion-version=4`),
     and wrapping it in quotes makes them part of the value.
4. Deploy.

## Backup & restore

A complete backup is three things. The database dump alone is not enough:

| What | Where | Why |
|---|---|---|
| Database | `./scripts/backup.sh` writes `./data/backups/capka-<UTC timestamp>.sql.gz` | Users, chats, settings, the task queue. |
| `.env` | The install directory (Coolify: the resource's environment variables) | `CAPKA_MASTER_KEY` decrypts the provider keys, connector sign-in tokens and chat secrets stored in the dump; with any other key they are unreadable and everyone is signed out. |
| Files | `./data`, except `./data/backups` | Chat and project workspaces (`./data/storage`: uploads and agent outputs) and the platform's other on-disk state. |

Dumps contain session tokens, password hashes and the encrypted secrets, so
`backup.sh` and the sidecar write them with mode `0600`. Keep copies **off the
box** (a disk failure or a lost VPS takes `./data/backups` with it), encrypt them
(e.g. `restic`, `age`, `gpg`), and store `.env` apart from the dumps — together
they decrypt everything.

`./data` is copied as files (`sudo tar` or `sudo rsync -a`, keeping owners).
Copied while the stack runs it can be a few minutes off from the dump; stop the
stack for a consistent pair.

### Scheduling

Either run `backup.sh` from the host's root crontab:

```cron
0 3 * * * cd /opt/capka && ./scripts/backup.sh >>/var/log/capka-backup.log 2>&1
```

or layer the sidecar, which dumps daily (`BACKUP_INTERVAL_SECONDS` in `.env`):

```bash
docker compose -f docker-compose.yml -f docker-compose.backup.yml up -d pg-backup
```

`up.sh`, `update.sh` and the installer run `docker compose up --remove-orphans`
without this overlay, which **removes the sidecar**. Re-run the command above
after each of them, or use the cron job, which updates do not touch.

Both delete dumps older than `RETENTION_DAYS` days (default 14; `0` or empty keeps
every dump), and only after a dump succeeded. The sidecar reads it from `.env`;
`backup.sh` from its environment (`RETENTION_DAYS=30 ./scripts/backup.sh`).

To test a backup without touching the live database, check that it is complete
and restore it into a scratch one. A dump that was cut short (pg_dump died, the
disk filled up) still restores without an error, just with part of the data, so
the end-of-dump marker is what tells them apart:

```bash
F=./data/backups/capka-<timestamp>.sql.gz
if gunzip -t "$F" && gunzip -c "$F" | tail -n 20 | grep -q 'PostgreSQL database dump complete'; then
  docker compose exec -T postgres createdb -U Capka capka_restore_test
  gunzip -c "$F" \
    | docker compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U Capka -d capka_restore_test >/dev/null \
    && docker compose exec -T postgres psql -U Capka -d capka_restore_test \
         -c 'SELECT (SELECT count(*) FROM chats) AS chats, (SELECT count(*) FROM messages) AS messages' \
    && echo "restore OK"
  docker compose exec -T postgres dropdb -U Capka capka_restore_test
else
  echo "INCOMPLETE: $F is cut short or unreadable"
fi
```

The counts should be close to the live database's at the time of the dump.

### Restore

```bash
sudo ./scripts/restore.sh ./data/backups/capka-<timestamp>.sql.gz
```

It refuses a dump that is not complete, stops `platform`, `sandbox-controller` and
`pg-backup`, replaces the database in one transaction (an error leaves it as it
was) and leaves the stack stopped. Then start the **same release the dump came
from**: `sudo sh scripts/up.sh`, or for a rollback see
[`UPGRADE.md`](UPGRADE.md#rollback). A newer image migrates the restored database
forward on boot. Restore with the stack's own `psql`, as the script does: dumps
from current `pg_dump` start with `\restrict`, which older `psql` clients reject.

`restore.sh` in v0.42.0 and earlier works differently: it restores over the live
schema, accepts a cut-short dump and restarts the platform. On such a checkout
swap in the current script first (it checks the dump itself). It finds the compose
files relative to itself, so it must stay in `scripts/`; `update.sh` and the
installer put the release's own copy back:

```bash
git fetch --depth 1 origin stable && git show FETCH_HEAD:scripts/restore.sh > scripts/restore.sh
```

**A dump older than `WORKSPACE_TTL_MS` (30 days) needs one more step before the
first start.** The controller deletes a workspace, files included, once its
`last_activity` in the database is older than `WORKSPACE_TTL_MS`. That value comes
back with the dump (file times do not count) and the first sweep runs a minute
after boot. So set `WORKSPACE_TTL_MS` in `.env` to at least the dump's age plus 30
days (e.g. `15552000000`, 180 days), and lower it again, with a re-run of
`sudo sh scripts/up.sh`, once people have worked in their chats; workspaces nobody
touched are deleted then. `GC_GRACE_MS` only covers directories that have no row,
so it does not help.

### Restoring on a new host

```bash
git clone --branch v<release-of-the-dump> https://github.com/LyoSU/capka.git /opt/capka
cd /opt/capka
sudo cp /path/to/backup/.env .env && sudo chmod 600 .env   # same CAPKA_MASTER_KEY
sudo sh scripts/up.sh                                      # empty database, no files yet
sudo ./scripts/restore.sh /path/to/backup/capka-<timestamp>.sql.gz   # leaves the stack stopped
sudo rsync -a /path/to/backup/data/ data/                  # ./data, without backups/
sudo sh scripts/up.sh
```

Copy `./data` back only after the restore, while `restore.sh` has the
controller stopped: the controller deletes workspace directories that have no
row in the database and have not changed for a week (`rsync -a` and `tar` keep
the old times), and on the empty database no workspace has a row.

A dump from v0.42.0 or earlier needs the `restore.sh` swap from [Restore](#restore)
before the `restore.sh` line, and one older than 30 days the `WORKSPACE_TTL_MS`
step there before the last `up.sh`.

If the log shows `[security] CAPKA_MASTER_KEY does not match the key that
encrypted the stored data`, the `.env` is not the one that belongs to the dump.

### Coolify

Coolify deploys one compose file, so the sidecar overlay cannot be layered and
there is no checkout to run the scripts from. Back up from the host instead.
Coolify names each container `<service>-<resource uuid>`; `docker ps` lists them.

Save the database dump as a script (e.g. `/root/capka-backup.sh`, `chmod 700`)
and run it from root's crontab by its path, so the `bash` shebang applies — a
`sh` cron line has no `pipefail` and would keep a failed dump. Then copy the file
off-box:

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077                                  # dumps hold session tokens and password hashes
mkdir -p /var/backups/capka && cd /var/backups/capka
F=capka-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
trap 'rm -f "$F.tmp"' EXIT
docker exec postgres-<uuid> pg_dump -U Capka -d Capka --clean --if-exists | gzip > "$F.tmp"
mv "$F.tmp" "$F"                           # only a finished dump gets the final name
find . -name 'capka-*.sql.gz*' -mtime +14 -delete   # nothing else prunes this directory; the * takes a .tmp a killed dump left
```

The files live in the host directory mounted at `/data` in the controller:

```bash
docker inspect sandbox-controller-<uuid> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

Copy `CAPKA_MASTER_KEY` and the other secrets out of the resource's environment
variables. To restore, stop the writers, replace the database, then redeploy the
resource from Coolify:

```bash
F=capka-<timestamp>.sql.gz
if gunzip -t "$F" && gunzip -c "$F" | tail -n 20 | grep -q 'PostgreSQL database dump complete'; then
  docker stop platform-<uuid> sandbox-controller-<uuid>
  { echo 'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
    gunzip -c "$F"; } \
    | docker exec -i postgres-<uuid> psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U Capka -d Capka >/dev/null \
    && echo "restore OK" \
    || echo "Restore failed and was rolled back: the database is as it was. platform and sandbox-controller are still stopped; redeploy the resource."
else
  echo "Not restoring: $F is cut short or unreadable"
fi
```

Check the marker first, as above: psql commits whatever a cut-short dump
contains, after dropping the old schema. On a new server, copy the files into the
controller's `/data` directory after the restore and before the redeploy, for the
reason given in [Restoring on a new host](#restoring-on-a-new-host). For a dump
older than 30 days set `WORKSPACE_TTL_MS` in the resource's environment before that
redeploy ([Restore](#restore)).

## Routing / TLS

The platform publishes on `${PLATFORM_PORT:-3000}` (all interfaces by default).
Front it with a reverse proxy, and on a host where Docker publishes past the
firewall (UFW), set `PLATFORM_BIND=127.0.0.1` so the port isn't reachable
directly from the internet — the proxy still reaches it via localhost:

- **Automatic HTTPS (Caddy):** the simplest path. Set `DOMAIN` and `up.sh`
  layers `docker-compose.tls.yml`, which terminates TLS for you.
- **Coolify's built-in Traefik:** Coolify routes to the container over the
  compose network from the `PUBLIC_URL` domain.
- **Your own reverse proxy** (nginx/Traefik/etc.): set `PLATFORM_BIND=127.0.0.1`,
  set `PLATFORM_PORT` to the port your proxy targets, and point the proxy at
  `http://localhost:<port>`. See the nginx example below.

In production, set `PUBLIC_URL` to the https:// address users open (`up.sh` sets
it from `DOMAIN`). Without it, session cookies are issued without the Secure
flag and the sign-in origin is taken from each request's Host / X-Forwarded-Host
header; with an http:// value only the Secure flag is lost. The platform logs a
`[config] PUBLIC_URL` warning at boot in either case.

### Example: host nginx

For a self-managed nginx in front of the loopback-published platform:

```nginx
server {
    listen 443 ssl;
    server_name capka.example.com;

    ssl_certificate     /etc/letsencrypt/live/capka.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/capka.example.com/privkey.pem;

    client_max_body_size 100M;   # allow large uploads into the sandbox

    location / {
        proxy_pass http://localhost:3000;   # PLATFORM_PORT
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;   # SSE / streaming
        proxy_set_header Connection $connection_upgrade;
    }
}
```

Set `PLATFORM_BIND=127.0.0.1` so the platform is reachable only through nginx,
and keep `PUBLIC_URL=https://capka.example.com` in sync with the served domain.

## Tracing (optional)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and Capka exports one trace per agent turn over
standard OTLP — turn → LLM calls → tool calls → sandbox request / MCP handshake,
with durations, models, token counts, retry/stall markers and error categories.
Any OpenTelemetry backend works; nothing is added to the compose stack.

```
# Local collector
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Langfuse Cloud — the ingestion-version header is required in practice,
# without it new data can lag by up to 10 minutes.
OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(pk-lf-...:sk-lf-...)>,x-langfuse-ingestion-version=4
```

**What leaves the host.** By default only structure: timings, model ids, token
counts, tool names, route templates, error *categories*. Never prompts,
completions, tool arguments/results, sandbox commands, filenames, session keys,
workspace tokens, or exception messages and stack traces — the exporter runs a
deny-by-default allowlist, so even a future SDK attribute cannot leak without
being added deliberately.

To include content, set `CAPKA_TELEMETRY_CONTENT=true`. If the collector is not on
this host you must ALSO set `CAPKA_TELEMETRY_CONTENT_REMOTE=true`; with only the
first flag the content is dropped and the boot log records why. Treat that as
sending your users' documents to a third party.

**Token counts.** They arrive as `capka.usage.*` attributes on the turn span
(input / output / cached / cache-write / reasoning, plus `capka.context.tokens` for
the last call's prompt size). A backend's own usage and cost graphs stay **empty**:
`ai@6` does not emit token attributes onto its spans at all, so there is nothing
for a backend to aggregate. This is not a misconfiguration on your side — read the
turn attributes instead, and keep using `/settings/usage` for spend. They are only
as good as what the provider reports: on an OpenAI-compatible endpoint usage has to
be asked for per request, and a gateway that refuses the ask leaves them at zero
(see `CAPKA_STREAM_USAGE` under Gotchas).

**What stays here.** Cost in USD is not exported (`CAPKA_TELEMETRY_COST=true` to
change that): the `usage` table is the money record — it holds pending
reservations and the shared-vs-own-key distinction that billing depends on, and a
second dollar figure elsewhere would be a second answer to the same question. The
division of labour is deliberate: money and the admin analytics live here, trace
structure and per-step latency live in the tracing backend.

**Limits.** HTTP/protobuf (default) and `http/json` only — `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`
is refused with a warning and falls back. Only agent spans are exported;
`CAPKA_TELEMETRY_SPAN_PREFIXES=*` widens that (a registered tracer provider also
wakes Next.js's own request spans). Standard `OTEL_SDK_DISABLED`,
`OTEL_TRACES_EXPORTER=none`, sampler and batch variables are honored.

## Gotchas seen in practice

- **`INVALID_ORIGIN` at login** → set `PUBLIC_URL` to the exact public origin
  (scheme + host, no trailing slash).
- **Coolify keeps a stale `${VAR:-default}`.** Coolify captures compose env
  defaults at first parse and keeps the captured value even after the compose
  default changes. If a knob (e.g. `SANDBOX_RUNTIME`, or any tuning var) is wrong
  and editing the compose default doesn't take, **edit the value in Coolify's
  Environment Variables** (Coolify blocks *deleting* a compose-declared var) and
  redeploy.
- **gVisor: `runtime runsc not registered`** but you didn't install gVisor → the
  stored `SANDBOX_RUNTIME` is stale `runsc`; set it back to `runc` (above).
- **Uploads fail / `413`** → raise the reverse proxy's body-size limit
  (`client_max_body_size` in nginx).
- **An OpenAI-compatible gateway breaks on every turn after an upgrade** → it may
  be rejecting `stream_options`, the parameter that asks for token counts on a
  stream. Capka asks optimistically, recognizes a rejection and re-streams without
  it, then stops asking that connection. If a gateway refuses in some way that
  doesn't read as a rejection, set `CAPKA_STREAM_USAGE=false` to stop asking
  entirely — at the cost of turns being recorded with no token counts.
- **Build OOM** doesn't apply on the pull path — no build runs on the box.
