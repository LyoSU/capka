FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# BuildKit cache mounts persist across builds even under Coolify's forced
# --no-cache (type=cache stores are not wiped by --no-cache). No `# syntax`
# directive needed — Docker 28's built-in frontend supports them, and the
# external frontend pull is unreliable inside Coolify's build helper.
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
# Cap the build heap so an oversized build fails as a Node heap error (build
# fails, host survives) rather than tripping the kernel OOM killer on a
# RAM-tight shared host. Tune via the build arg if the build legitimately needs more.
ARG NODE_BUILD_HEAP_MB=1536
ENV NODE_OPTIONS="--max-old-space-size=${NODE_BUILD_HEAP_MB}"
RUN --mount=type=cache,target=/app/.next/cache npm run build

# Dev target: full deps, no production build — source is bind-mounted at runtime
# and `next dev` provides hot-reload. Used by docker-compose.dev.yml.
FROM node:22-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
EXPOSE 3000
ENV PORT=3000 HOSTNAME="0.0.0.0"
CMD ["npm", "run", "dev"]

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# SQL migration files — needed at runtime for auto-migrate on boot (standalone
# output doesn't include them since they aren't traced as code dependencies).
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
RUN mkdir -p data/storage && chown -R nextjs:nodejs data
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME="0.0.0.0"
# Let the in-process task worker own SIGTERM (it drains in-flight tasks before
# exiting). Without this, Next's own handler calls server.close()→exit(143),
# which for a background task with no open SSE fires before the drain. Set on the
# prod image only — `next dev` (the dev stage) keeps Next's instant Ctrl-C.
ENV NEXT_MANUAL_SIG_HANDLE=1
CMD ["node", "server.js"]
