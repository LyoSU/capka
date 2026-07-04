# Development

Use the Docker dev stack for day-to-day work:

```bash
npm run docker:dev
```

It starts the app, Postgres, the sandbox controller, the Docker socket proxy, and
the sandbox image with development defaults. Open <http://localhost:3000> and
create the admin account.

## Commands

```bash
npm run dev            # Next.js dev server; requires DATABASE_URL
npm run docker:dev     # full local stack with build overlay
npm run up             # create missing .env secrets, then start production stack
npm run docker:prod    # start production compose stack
npm run docker:down    # stop the stack
npm run sandbox:build  # rebuild the sandbox image
npm test               # Vitest unit tests
```

## Notes

- `docker-compose.yml` is the production stack and pulls release images
- `docker-compose.dev.yml` adds local development behavior
- `docker-compose.build.yml` builds images from source
- `docker-compose.tls.yml` adds Caddy HTTPS when `DOMAIN` is set
- `docker-compose.backup.yml` adds a scheduled Postgres backup sidecar

Restart the platform container after editing worker, runner, instrumentation, or
Telegram bot code. HMR does not reload the in-process worker.

For production deploys, use [`DEPLOY.md`](DEPLOY.md).
