# Deploy (Coolify @ hetzner-auction)

How unClaw runs in production. Coolify reads `docker-compose.yaml` (build-pack
= dockercompose); `docker-compose.yml` is the local-dev variant.

## Topology

```
Browser ──HTTPS──► Cloudflare (edge cert *.yuri.ly, "Always Use HTTPS")
                        │  proxied, SSL mode = Full
                        ▼
              host nginx :443 (self-signed origin cert)   ← hetzner-auction
                        │  proxy_pass 127.0.0.1:3100
                        ▼
              platform :3000 (Next.js standalone)
        ┌───────────────┼────────────────────┐
        ▼               ▼                     ▼
   postgres:5432   sandbox-controller:3001   sandbox (one-shot image build)
                        │ DOCKER_HOST=tcp://socket-proxy:2375
                        ▼
                  socket-proxy ──(docker.sock :ro)──► per-session sandboxes
```

Coolify here is **build + orchestration only**; public routing is the host's
nginx (Coolify's Traefik is stopped on this server — all yuri.ly domains are
fronted by host nginx + Cloudflare).

## Required env (Coolify → unclaw → Environment Variables)

| Key | Value / notes |
|---|---|
| `PUBLIC_URL` | `https://unclaw.yuri.ly` — drives both Traefik routing and the app's public origin (better-auth `trustedOrigins`). Missing/wrong → `INVALID_ORIGIN` on login/register. |
| `UNCLAW_MASTER_KEY` | app master key / better-auth secret |
| `CONTROLLER_SECRET` | platform ↔ sandbox-controller bearer |
| `POSTGRES_PASSWORD` | DB password |
| `SANDBOX_ALLOW_NETWORK` | optional, default `false` |

## Host-specific deltas (this is a host-nginx host, not Traefik)

Two changes in `docker-compose.yaml` exist specifically because this host uses
its own nginx instead of Coolify's Traefik. On a Traefik host, revert both:

1. **`sandbox: restart: "no"`** — the one-shot image-builder must not loop.
   Coolify injects `restart: unless-stopped` into every service; combined with
   the controller's `depends_on … service_completed_successfully` that caused a
   restart-loop + `No such container` failure on `compose up`.
2. **`platform: ports: ["127.0.0.1:3100:3000"]`** — publish to loopback so host
   nginx can reverse-proxy it (no Traefik to route `SERVICE_FQDN` here).

## Build speed

`Dockerfile` uses BuildKit cache mounts (`--mount=type=cache`) on `npm ci` and
`npm run build` (`.next/cache`). They persist across builds even though Coolify
forces `--no-cache`. Do **not** add a `# syntax=` directive — Docker 28's
built-in frontend supports the mounts, and the external frontend pull is
unreliable inside Coolify's build helper (caused an 82s exit-255 failure).

## Host nginx (lives outside Coolify — remember on migration)

- `/etc/nginx/sites-available/unclaw.yuri.ly.conf` → `proxy_pass http://localhost:3100`, symlinked into `sites-enabled/`. `client_max_body_size 100M`.
- Origin TLS: self-signed `/etc/nginx/ssl/unclaw.yuri.ly.{crt,key}`. Cloudflare SSL mode **Full** (not Full strict) accepts it. Let's Encrypt HTTP-01 fails here (CF "Always Use HTTPS" 301s the ACME challenge).

## Cloudflare

`unclaw.yuri.ly` → A `46.4.123.254` (+ AAAA `2a01:4f8:141:3002::2`), proxied, SSL = Full.

## Gotchas seen in practice

- Build OOM on a RAM-tight host → 62 GB host + `NODE_BUILD_HEAP_MB` cap.
- `No such container` on `compose up` → sandbox restart-loop → `restart:"no"`.
- `INVALID_ORIGIN` at login → set `PUBLIC_URL`.
- `503` via Cloudflare while origin returns 307 directly → CF DNS pointed at the old server; fix the A/AAAA records.
