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
| **sandbox-controller** | Small HTTP service with Docker-socket access that spawns and tears down per-session sandbox containers. **Root-equivalent on the host** — guarded by a shared secret. |
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

`docker-compose.yaml` (note the `.yaml`) is a Coolify-tailored variant (Traefik
routing, no host port publish) — set `PUBLIC_URL` in the Coolify env and it drives
both the route and the app origin.

Put a TLS-terminating reverse proxy in front of `:3000` for any internet-facing
deployment.

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

Private / unpublished.
