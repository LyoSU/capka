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
4. Deploy. Coolify's Traefik terminates TLS via the `PUBLIC_URL` domain.

To publish this as a one-click Coolify service template, submit
`docker-compose.coolify.yml` to the Coolify `coolify-io/coolify` service-templates
repo with the env keys above marked as required.
