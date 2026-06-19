# unClaw

A self-hosted, extensible AI assistant platform for non-technical teams. Staff
talk to a capable agent (chat or Telegram) that can run code, process files, and
use skills/MCP connectors — all behind a single admin-configured provider key, in
an isolated sandbox.

- **Durable agent loop** — every turn is a task on a Postgres-backed queue, run by
  an in-process worker. A dropped connection or a redeploy doesn't lose the reply.
- **Isolated execution** — code, file conversion, scraping, and document
  generation run inside a per-session Docker sandbox (Python 3.12, Node 22, Java,
  FFmpeg, ImageMagick, LibreOffice, LaTeX, Playwright, OCR, …), never on the host.
- **Extensible** — Anthropic-compatible skills, MCP connectors (incl. OAuth), and a
  marketplace, with per-capability allow/ask/deny governance and an audit log.
- **Friendly by design** — provider/account errors are translated into calm,
  role-aware, localized messages (the end user never sees a raw `402`).

> Built on a customized Next.js 16. See `AGENTS.md` — this is **not** stock
> Next.js; check `node_modules/next/dist/docs/` before changing framework code.

## Architecture

| Service | What it is |
|---|---|
| **platform** | Next.js app + the in-process task worker (chat UI, APIs, agent loop). |
| **postgres** | System of record **and** the task queue / realtime bus (LISTEN/NOTIFY). |
| **sandbox-controller** | Small HTTP service that spawns and tears down per-session sandbox containers. Reaches the Docker daemon through a restricted socket-proxy (not the raw socket), guarded by a shared secret. See *Sandbox isolation* below. |
| **socket-proxy** | Filters the Docker API down to container + exec endpoints; the host socket is mounted read-only here alone, on an isolated network. |
| **sandbox** | The execution image (`Dockerfile.sandbox`), built once and reused per session. |

The platform never touches the Docker socket directly; it calls the controller
over the internal network, authenticated with `CONTROLLER_SECRET`.

## Quick start (development)

Zero-config — `docker-compose.dev.yml` supplies safe dev defaults (loopback-only
ports, dev secrets), so you don't need to create an env file:

```bash
npm run docker:dev
```

Then open http://localhost:3000 and complete the first-run setup (see below).

## Deployment (production)

The base `docker-compose.yml` publishes only the platform on `:3000`; Postgres and
the controller stay on the internal network.

**One command — no manual secrets, no external account beyond an LLM key:**

```bash
npm run up                                  # generate secrets → .env, then start
PUBLIC_URL=https://unclaw.example.com npm run up   # set the public origin too
```

`scripts/up.sh` generates strong values for the three secrets below into `.env`
on first run (idempotent: it never overwrites a value you've set, and adds a
missing one on upgrade), then runs `docker compose up`. Prefer to manage secrets
yourself? Set them in `.env` or your platform's env instead (see `.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `POSTGRES_PASSWORD` | ✅ | Postgres password; the platform's `DATABASE_URL` is derived from it. |
| `CONTROLLER_SECRET` | ✅ | Shared platform↔controller secret. The controller **refuses to boot** on the default value. `openssl rand -hex 32`. |
| `UNCLAW_MASTER_KEY` | ✅ | 64-hex root key that encrypts provider API keys at rest, kept **outside** the DB so a DB leak alone can't decrypt them. `openssl rand -hex 32`. |
| `PUBLIC_URL` | optional | Public origin (e.g. `https://unclaw.example.com`). Unset → derived from proxy headers (`X-Forwarded-*` / `Host`). Set it behind a proxy: it's the non-spoofable source for auth callbacks and absolute links. |

`docker-compose.coolify.yml` is a Coolify-tailored variant (Traefik routing, no
host port publish). It is **not** auto-selected — point Coolify's
`docker_compose_location` at it, or run `docker compose -f docker-compose.coolify.yml …`.
The default `docker compose up` uses the host-agnostic `docker-compose.yml`.

Put a TLS-terminating reverse proxy in front of `:3000` for any internet-facing
deployment.

### Prebuilt images (skip the build)

Release tags publish `platform`, `controller`, and `sandbox` images to GHCR
(`.github/workflows/publish-images.yml`), so a host with no build toolchain can
fetch them instead of compiling:

```bash
docker compose pull        # platform + controller from ghcr.io/lyosu/unclaw-*
npm run up                 # generate secrets if needed, then start
```

The compose `build:` stanzas remain a fallback, so cloning and building still
works with no images present.

## Sandbox isolation & hardening

Untrusted code runs in per-session containers that are never privileged, drop all
capabilities, run non-root, and have no network by default; the controller reaches
Docker only through a restricted socket-proxy. This is defense-in-depth — for a
true "escape ≠ host root" boundary run a **rootless** Docker daemon.

See **[`SECURITY.md`](SECURITY.md)** for the full threat model, the rootless
setup, the per-deployment hardening table, and how to report a vulnerability.

To allow sandboxes outbound network access (off by default), set
`SANDBOX_ALLOW_NETWORK=true` in the environment.

## First run

1. Open the app — you're routed to **`/setup`** to create the admin account.
2. In **Settings → Connections**, add an AI provider key (OpenAI, Anthropic,
   OpenRouter, Ollama, …) and pick default models.
3. New-user registration is **closed by default**; the admin invites/creates
   users from settings.
4. *(Optional)* In **Settings → Integrations**, add a Telegram bot token to let
   staff chat with the same agent from Telegram — each Telegram user links to
   their account and messages run through the same durable engine.

## Development scripts

```bash
npm run dev            # Next.js dev server (expects an external Postgres via DATABASE_URL)
npm run docker:dev     # full stack with dev defaults (recommended)
npm run up             # prod: generate secrets into .env (if needed), then start
npm run docker:prod    # build + run detached (expects secrets already set)
npm run docker:down    # stop the stack
npm run sandbox:build  # (re)build the sandbox execution image
npm test               # vitest (unit). Integration tests are gated behind RUN_INTEGRATION=1
```

After editing the worker, runner, instrumentation, or the Telegram bot, restart
the platform container — HMR does not reload the in-process worker loop.

## License

unClaw core is licensed under the **GNU AGPL-3.0** (see `LICENSE`). You may
self-host, modify, and redistribute it under those terms; if you offer it as a
network service, the AGPL's source-availability obligations apply.

Enterprise features (SSO/OIDC & SCIM, advanced RBAC, Helm/k8s packaging,
observability integrations, SLA support) are developed as a separate commercial
edition and are not part of this repository.

Contributions are accepted under a Contributor License Agreement — see
`CONTRIBUTING.md`.
