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
| `docker-compose.yml` | **The stack you deploy.** Pull-only (prebuilt GHCR images), internal-only Postgres/controller, platform on loopback. |
| `docker-compose.dev.yml` | Local dev overlay (hot reload, dev secrets). |
| `docker-compose.build.yml` | Build-from-source overlay (`CAPKA_BUILD=1`). |
| `docker-compose.tls.yml` | Automatic HTTPS via Caddy (`up.sh` layers it when `DOMAIN` is set). |
| `docker-compose.backup.yml` | Scheduled `pg_dump` sidecar. |

Pin a release with `CAPKA_VERSION=vX.Y.Z` in `.env`; unset ⇒ `:latest`.

## Which git ref to deploy

Images are published on release tags only, so **the compose file on `master` is
always newer than any image you can pull.** A deployment that follows `master`
without building from source therefore runs new compose against the last
release's images — and a service the compose file added but the image does not
contain yet cannot start at all.

| Ref | Use it for | Images |
|---|---|---|
| `stable` | **Pull-only deployments** (Coolify, `update.sh`). CI moves it to each release after its images are published, so compose and images always match. | `:latest` |
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
clone: `DOMAIN=capka.example.com ./scripts/up.sh` (or `npm run up`). Re-running
the installer upgrades in place. Environment variables are listed in
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
     `openssl rand -hex 32` each.
   - `SANDBOX_RUNTIME` = `runc` (default). For untrusted/multi-tenant code,
     install gVisor on the host (`sudo sh scripts/install-gvisor.sh`) and set
     `runsc` — the controller then refuses to boot until gVisor is present
     (fail-closed).
   - Optional tuning (defaults in parentheses): `SANDBOX_MEMORY_MB` (1024),
     `SANDBOX_PIDS_LIMIT` (256),
     `MAX_SESSIONS_PER_USER` (2), `SANDBOX_IDLE_TTL_MS` (900000),
     `WORKSPACE_TTL_MS` (2592000000), `GC_GRACE_MS` (604800000),
     `SANDBOX_ALLOW_NETWORK` (true).
   - Optional tracing (see [Tracing](#tracing-optional)):
     `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`. Paste the
     header value **unquoted**, exactly as one line — it legitimately contains
     `=` and `,` (`Authorization=Basic <base64>,x-langfuse-ingestion-version=4`),
     and wrapping it in quotes makes them part of the value.
4. Deploy.

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
