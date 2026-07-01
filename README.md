# Capka

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Images on GHCR](https://img.shields.io/badge/images-ghcr-green.svg)](DEPLOY.md)
[![Live demo](https://img.shields.io/badge/live%20demo-capka.yuri.ly-ff6f3c.svg)](https://capka.yuri.ly/)

<p align="center"><img src="./docs/assets/logo.webp" alt="Capka" width="180"></p>

Capka is a self-hosted workspace for AI agents.

You run it on your own server, connect your model provider, and use it for work
that needs more than a chat box: reading files, running code, converting
documents, building reports, debugging projects, and calling MCP tools.

The important part is the sandbox. Each chat gets its own Linux container, so the
agent can work with files and tools without direct access to the host.

This is a solo-built open-source project. The goal is not to look like a big
platform. The goal is to be useful, understandable, and careful enough to run for
yourself, your friends, or a small team.

[Try the live demo](https://capka.yuri.ly/).

![Capka turning uploaded files into a PDF report and Excel workbook](./docs/assets/demo.webp)

## What It Is For

Use Capka when you want:

- a private AI agent UI that you can self-host
- file, code, and document workflows, not only chat
- per-chat containers for safer tool and code execution
- long-running tasks that survive browser closes and restarts
- your own provider keys, models, MCP connectors, and governance rules

It is not a serverless app. Capka needs a long-running Docker host because the
agent worker runs inside the platform process.

## What It Runs

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

Open <http://localhost:3000>, create the admin account, then add a provider key
in **Settings -> Connections**.

## Deploy

On a Linux server with DNS pointed at the host:

```bash
curl -fsSL https://raw.githubusercontent.com/LyoSU/capka/master/install.sh | DOMAIN=capka.example.com sh
```

Already cloned:

```bash
git clone https://github.com/LyoSU/capka
cd capka
DOMAIN=capka.example.com ./scripts/up.sh
```

`DOMAIN` enables automatic HTTPS through Caddy. Without it, Capka serves plain
HTTP on `:3000`; put it behind your own TLS proxy and set `PUBLIC_URL`.

See [`DEPLOY.md`](DEPLOY.md) for Coolify, compose files, host nginx, and common
deployment gotchas.

## Requirements

Linux with Docker, on `x86_64` or `arm64`.

| Profile | CPU | RAM | Disk |
|---|---:|---:|---:|
| Minimum | 1-2 vCPU | 2 GB | 20 GB |
| Recommended | 2 vCPU | 4 GB | 40 GB |

Use more RAM for concurrent users, large document jobs, or gVisor.

## First Run

1. Open `/setup` and create the admin account
2. Add provider keys in **Settings -> Connections**
3. Choose default models
4. Invite users from the admin panel
5. Optional: add a Telegram bot token in **Settings -> Integrations**

Registration is invite-only by default.

## Security Short Version

Sandboxes are unprivileged containers with dropped Linux capabilities and no host
filesystem access. The controller reaches Docker through `socket-proxy`, not the
raw Docker socket.

Sandbox internet access is controlled in **Settings -> Security -> Internet
access**. When enabled, Capka blocks private ranges and cloud metadata endpoints.

For untrusted or multi-tenant use, read [`SECURITY.md`](SECURITY.md). Prefer
rootless Docker and gVisor:

```bash
sudo sh scripts/install-gvisor.sh
# restart Docker
SANDBOX_RUNTIME=runsc
```

## Useful Links

- [`DEPLOY.md`](DEPLOY.md): production deploys and Coolify
- [`SECURITY.md`](SECURITY.md): threat model and hardening
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md): local development
- [`docs/UPGRADE.md`](docs/UPGRADE.md): upgrade notes
- [`CONTRIBUTING.md`](CONTRIBUTING.md): contributions and CLA

## License

Capka is licensed under the [GNU AGPL-3.0](LICENSE). If you run a modified
version as a public network service, the AGPL source-availability terms apply.
