# Capka

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Images on GHCR](https://img.shields.io/badge/images-ghcr-green.svg)](docs/DEPLOY.md)
[![Website](https://img.shields.io/badge/website-capka.vercel.app-22190f.svg)](https://capka.vercel.app/)
[![Live demo](https://img.shields.io/badge/live%20demo-capka.yuri.ly-ff6f3c.svg)](https://capka.yuri.ly/)

<p align="center"><img src="./docs/assets/logo.webp" alt="Capka" width="180"></p>
<p align="center"><strong>Self-hosted AI workspace with a sandbox and file storage for every chat</strong></p>
<p align="center">
  <a href="https://capka.vercel.app/">Website</a> |
  <a href="https://capka.yuri.ly/">Live demo</a> |
  <a href="#run-locally">Run locally</a> |
  <a href="#deploy">Deploy</a> |
  <a href="SECURITY.md">Security</a>
</p>

Capka is a self-hosted AI workspace where every chat gets its own Linux sandbox
and file storage

I wanted something I could run myself, connect to my own models and API keys, and
share with a small team. Not another hosted chat product locked to one vendor.

I have followed LLMs and agent tools since the start, and tried a lot of them in
real work. A lot of them still feel like chat wrappers, are hard to self-host, or
are unpleasant to use every day.

Capka is where I put the parts I actually wanted: files, tools, code execution,
durable tasks, isolated workspaces, MCP, and a UI that does not fight you.

The workflow is intentionally simple:

1. You upload files, or the agent downloads or creates them during the chat
2. Each chat gets its own Linux sandbox and its own file storage
3. The agent works inside that workspace and returns files you can use.

That covers a lot of real work: reports, spreadsheets, PDFs, research, document
conversion, file cleanup, small code changes, and other tasks where the useful
output is not just a message.

You can close the tab while it works. The task keeps running.

This is a solo project, built seriously. I am trying to make the AI tool I
actually want to use.

There is a longer walkthrough on the [website](https://capka.vercel.app/), or you
can [try the live demo](https://capka.yuri.ly/) and hand it a real task right now.

![Capka turning uploaded files into a PDF report and Excel workbook](./docs/assets/demo.webp)

## At a glance

| | |
|---|---|
| **Runs on** | Your Linux server with Docker |
| **Works with** | Files uploaded by the user, plus files the agent downloads or creates inside the chat |
| **Isolation** | One sandbox and one file workspace per chat |
| **Models** | Cloud providers or local models through Ollama |
| **Users** | Multi-user, registration closed by default |
| **Admin** | Users, auth, providers, MCP, skills, policies, security, usage, updates |

## What It Is For

Use Capka when the result should be a file, a code change, or a checked piece of
work, not only a chat reply:

- reports and spreadsheet work
- PDFs and document conversion
- research over provided or downloaded files
- file organization and cleanup
- repetitive office tasks
- small coding and debugging jobs
- workflows through MCP tools and connectors

## Is Capka for you?

**Reach for Capka if:**

- you want a finished file back — a report, a patch, a clean dataset — not just a chat reply
- your files should not leave your own infrastructure
- you would rather choose models and pay for tokens than pay a per-seat subscription
- you have a small Linux server, or do not mind renting one

**Look elsewhere if:**

- you just want to chat with a model and never touch files — a plain chat app is simpler
- nobody wants to run and maintain a server — hosted products exist for a reason
- you need vendor support with an SLA — Capka is open source, and support lives in GitHub issues

## For teams

Capka works well for small teams that want shared models, tools, and admin
control without putting everyone in the same workspace.

Admins get one place to manage the instance:

| Area | What admins control |
|---|---|
| Users | roles, pending approvals, registration mode |
| Models | provider keys, default models, local or cloud providers |
| Tools | MCP connectors, skills, marketplace plugins |
| Safety | allow, ask, deny policies, audit log, sandbox internet access |
| Ops | usage, billing status, updates, Telegram bot setup |

Each chat still gets its own sandbox and file storage, so team members can work
on separate tasks without sharing one messy workspace.

## How It Runs

| Service | Purpose |
|---|---|
| `platform` | Next.js app, APIs, agent loop, and worker |
| `postgres` | Database and task queue |
| `sandbox-controller` | Creates and removes per-chat containers |
| `socket-proxy` | Gives the controller restricted Docker API access |
| `sandbox` | Execution image used by agent sessions |

Sandboxes include Python, Node, Java, FFmpeg, ImageMagick, LibreOffice, LaTeX,
Playwright, OCR tooling, and other common utilities.

## Run Locally

```bash
npm run docker:dev
```

Open <http://localhost:3000>. If no admin account exists, Capka redirects you to
setup. After that, add a provider key in **Settings -> Connections**.

## Deploy

On a fresh Linux server, one command installs Docker (if needed), fetches Capka,
generates secrets, and brings the stack up:

```bash
curl -fsSL https://raw.githubusercontent.com/LyoSU/capka/master/install.sh | sh
```

It asks how people should reach Capka. **No domain? Just press Enter** — you get
a free HTTPS address with a real certificate (`https://<your-ip>.sslip.io`). Have
a domain? Type it and Caddy provisions HTTPS for it automatically. Either way the
installer waits until the app answers and then prints the address to open.

Already own a domain and want to skip the prompt:

```bash
curl -fsSL https://raw.githubusercontent.com/LyoSU/capka/master/install.sh | DOMAIN=capka.example.com sh
```

Already cloned the repo? Run `./scripts/up.sh` (or `DOMAIN=… ./scripts/up.sh`).
Re-running the installer or `up.sh` upgrades in place and reprints the address.

Running on a server that already hosts other sites? The installer notices an
existing web server on ports 80/443, or a busy port 3000, stays out of their way,
and prints how to front Capka with your own proxy. See
[`docs/DEPLOY.md`](docs/DEPLOY.md) for Coolify, host nginx, and gotchas.

## Requirements

Linux with Docker, on `x86_64` or `arm64`.

| Profile | CPU | RAM | Disk |
|---|---:|---:|---:|
| Minimum | 1-2 vCPU | 2 GB | 20 GB |
| Recommended | 2 vCPU | 4 GB | 40 GB |

Use more RAM for concurrent users, large document jobs, or gVisor. The installer
checks memory and disk up front and refuses a box that's clearly too small (the
sandbox image alone unpacks to ~7.5 GB).

## First Run

1. Open the address the installer printed — your domain, the free `sslip.io`
   address, or `http://<server-ip>:3000`. Lost it? Re-run `sudo ./scripts/up.sh`
   in the install directory and it prints the address again.
2. Capka redirects to setup if no admin account exists
3. Add provider keys in **Settings -> Connections**
4. Choose default models
5. Open registration or use approval mode from the admin panel
6. Optional: add a Telegram bot token in **Settings -> Integrations**

Registration is closed by default after setup. Admins can switch it to open or
approval mode in **Settings -> Authentication**.

## Troubleshooting

- **Certificate warning right after install.** Caddy is still fetching the
  certificate — wait ~30s and reload; first issuance can take a minute.
- **Can't reach the address at all.** Open the needed ports in your cloud
  provider's firewall / security group — 80 and 443 for HTTPS, or your app port
  for plain HTTP. This is the most common cause on a fresh VPS.
- **It skipped HTTPS / "port 80 in use".** Another web server is already on this
  box; Capka runs on `http://127.0.0.1:<port>`. Point your existing proxy at it
  and set `PUBLIC_URL` (see [`docs/DEPLOY.md`](docs/DEPLOY.md)).
- **Reinstalling and the database won't start.** A regenerated password is
  repaired automatically. Only if Postgres itself is corrupt: `docker compose
  down -v` wipes the database volume and starts clean — this deletes chats and
  settings.
- **See what's happening.** In the install directory: `docker compose ps`, and
  `docker compose logs platform` (or `sandbox-controller`).

## Security Short Version

Sandboxes are unprivileged containers with dropped Linux capabilities and no host
filesystem access. The controller reaches Docker through `socket-proxy`, not the
raw Docker socket.

Sandbox internet access is controlled in **Settings -> Security -> Internet
access**. When enabled, Capka blocks private ranges and cloud metadata endpoints.

For untrusted or multi-tenant use, read [`SECURITY.md`](SECURITY.md). Turn on
gVisor for kernel-level sandbox isolation:

```bash
sudo sh scripts/install-gvisor.sh   # installs runsc, enables userns-remap
# restart Docker, then set in .env:
SANDBOX_RUNTIME=runsc
```

For the strongest boundary, also run Docker rootless (a container escape then
lands unprivileged); it needs one extra `DOCKER_SOCKET` setting —
see [`SECURITY.md`](SECURITY.md).

## Useful Links

- [`docs/DEPLOY.md`](docs/DEPLOY.md): production deploys and Coolify
- [`SECURITY.md`](SECURITY.md): threat model and hardening
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md): local development
- [`docs/UPGRADE.md`](docs/UPGRADE.md): upgrade notes
- [`CONTRIBUTING.md`](CONTRIBUTING.md): contributions and CLA

## License

Capka is licensed under the [GNU AGPL-3.0](LICENSE). If you run a modified
version as a public network service, the AGPL source-availability terms apply.
