# Deploying unClaw on Coolify

Coolify runs the full compose stack (including the Docker-socket sandbox) since
it deploys onto a host with a Docker daemon.

1. **New Resource → Docker Compose**, point it at this repo.
2. Set **docker_compose_location** to `/docker-compose.coolify.yml` (the
   Traefik-routed variant; the default `docker-compose.yml` publishes a raw port).
3. Set environment variables:
   - `PUBLIC_URL` = `https://<your-domain>` (drives Traefik routing + app origin)
   - `UNCLAW_MASTER_KEY`, `CONTROLLER_SECRET`, `POSTGRES_PASSWORD` = `openssl rand -hex 32` each
   - `SANDBOX_ALLOW_NETWORK` = `false` (default)
   - `SANDBOX_RUNTIME` = `runc` (default — standard Docker isolation, boots with no
     host setup). For untrusted/multi-tenant code, install gVisor on the host
     (`sudo sh scripts/install-gvisor.sh`) and set this to `runsc`; the controller
     then **refuses to boot until gVisor is present** (fail-closed by design).
4. Deploy. Coolify's Traefik terminates TLS via the `PUBLIC_URL` domain.

> **gVisor / `SANDBOX_RUNTIME` gotcha.** Coolify captures `${VAR:-default}` values
> from the compose file at first parse and keeps the captured value even after the
> compose default changes. If the controller crash-loops with *“runtime runsc not
> registered”* but you haven't installed gVisor, the stored value is stale: **edit
> `SANDBOX_RUNTIME` to `runc`** in Environment Variables (Coolify blocks *deleting*
> a compose-declared var) and redeploy.

To publish this as a one-click Coolify service template, submit
`docker-compose.coolify.yml` to the Coolify `coolify-io/coolify` service-templates
repo with the env keys above marked as required.
