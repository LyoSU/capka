# Deploying unClaw on Fly.io (platform-only)

Fly.io runs your app as a Firecracker microVM and gives it **no Docker daemon**.
The sandbox-controller spawns per-session sandbox **containers** via the Docker
socket, so it cannot run on Fly. This deploys the **chat/agent platform only** —
no sandboxed code execution (file conversion, scraping, code running).

For the full product, self-host the compose stack on any host with Docker (see the
README). A future controller backend that spawns **Fly Machines** (true microVM
isolation, arguably better than the Docker-socket model) would let Fly host the
sandbox too — that's a roadmap item, not available today.

## Steps

```bash
# 1. Install flyctl and log in (interactive).
fly auth login

# 2. Create the app from deploy/fly.toml (don't deploy yet).
fly launch --no-deploy --copy-config --name unclaw   # edit name as needed

# 3. Provision Postgres and attach it — this sets DATABASE_URL automatically.
fly postgres create --name unclaw-db
fly postgres attach unclaw-db

# 4. Set the required secrets. PUBLIC_URL must match your Fly hostname so auth
#    cookies (the secure-prefix) and callbacks resolve correctly.
fly secrets set \
  UNCLAW_MASTER_KEY=$(openssl rand -hex 32) \
  CONTROLLER_SECRET=$(openssl rand -hex 32) \
  PUBLIC_URL=https://unclaw.fly.dev      # use your app's actual *.fly.dev host

# 5. Deploy the prebuilt image referenced in deploy/fly.toml.
fly deploy

# 6. Open it and finish the setup wizard.
fly open
```

## Notes

- `deploy/fly.toml` pulls `ghcr.io/lyosu/unclaw-platform:latest` — publish that image
  first by pushing a `v*` tag (see `.github/workflows/publish-images.yml`), and make
  the GHCR package public, or Fly won't be able to pull it.
- `CONTROLLER_SECRET` is required (the platform expects it) even though no controller
  runs here; set it to any strong value.
- Any feature that needs the sandbox will surface a friendly "unavailable" error on
  this deployment — expected, since there is no controller.
- Postgres is the system of record **and** the task queue; back it up (Fly Postgres
  snapshots, or `pg_dump` from a machine with access).
