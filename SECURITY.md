# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **ua.lyo.su@gmail.com**
(or open a GitHub private security advisory). Do not file public issues for
undisclosed vulnerabilities. We aim to acknowledge within 72 hours.

## Sandbox isolation & hardening

Untrusted code runs in per-session containers locked down by a tested builder
(`sandbox-controller/sandbox-spec.js`): never privileged, `no-new-privileges`,
**all capabilities dropped** (only `CHOWN`/`SETUID`/`SETGID` added back for the
boot sequence), memory / CPU / PID limits, and **no network by default**. The
container starts as root just long enough for its entrypoint to chown the
bind-mounted workspace, then **drops to the unprivileged `1000:1000` user**;
every command the agent runs is pinned to `1000:1000`, so no untrusted code ever
runs as root. The controller never lets a caller specify container options — it
only requests this fixed, safe shape.

Each user gets their own per-user workspace and `/shared` directories, and a
container only ever bind-mounts the requesting user's own paths — so the shared
`1000` uid never crosses the isolation boundary (separation is by container +
bind mount, not by uid).

The controller reaches the Docker daemon through a **socket-proxy** that exposes
only the container and exec endpoints (build, pull, image, network, volume, and
swarm management are denied), so the raw host socket is never mounted into the
controller itself. The platform never touches the Docker socket directly.

### Isolation runtime: runc by default, gVisor opt-in

The hardening above always applies. The OCI **runtime** is a separate, explicit knob:

- **`runc` (default)** — standard Docker isolation. The stack boots anywhere with
  no host setup; suitable for single-operator and trusted-user deployments. The
  controller logs an `isolation.unhardened` warning at boot so the posture is visible.
- **`runsc` (gVisor, opt-in)** — a user-space kernel that intercepts container
  syscalls, giving a far stronger container↔host boundary with **no KVM required**
  (so it runs on ordinary VPS hosts, unlike Kata/Firecracker). Enable it with
  `sudo sh scripts/install-gvisor.sh` on the host (also turns on `userns-remap`)
  plus `SANDBOX_RUNTIME=runsc`. The resulting "secure" profile is **fail-closed**:
  the controller refuses to boot if `runsc` isn't registered on the daemon — it
  never silently falls back to `runc`.

For untrusted or multi-tenant code, combine gVisor with rootless Docker (below).

### This is defense-in-depth, not a hard boundary

A compromised controller could still create a non-privileged sandbox. The only
way to make a container escape *not* equal host root is to run the Docker daemon
**rootless**.

```bash
# on the host, as a non-root user
# (see https://docs.docker.com/engine/security/rootless/)
dockerd-rootless-setuptool.sh install
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
npm run up   # the stack now drives a rootless daemon; an escape lands unprivileged
```

## Hardening posture by deployment

| Deployment | Required posture |
|---|---|
| Single-operator / trusted users | Default stack. Keep `SANDBOX_ALLOW_NETWORK=false` unless needed. |
| Team, semi-trusted users | Above + rootless Docker, set `PUBLIC_URL`, TLS in front (see Caddy profile). |
| Multi-tenant / internet-facing | Above + rootless or gVisor (`runsc`) runtime, network egress policy, external managed Postgres, regular backups. |

## Network egress from sandboxes

Sandboxes have **no outbound network by default** (fail-closed). Set
`SANDBOX_ALLOW_NETWORK=true` only if agent code legitimately needs the internet
(package installs, scraping, outbound APIs) — it widens the blast radius of any
sandbox compromise. The in-container egress firewall additionally blocks the
cloud metadata range and refuses to start if its rules can't be verified.

## Marketplace, plugins & third-party code

Installing a plugin pulls code from a third-party repo into the capability system.
The trust model:

- **Pinned to a commit.** An install resolves its source ref to a concrete git
  commit and pulls the tree + files *at that SHA* — a consistent snapshot and a
  provenance record of exactly what was installed. A re-install re-pulls the same
  pinned commit; only an explicit upgrade moves the pin.
- **Code execution is disabled by default.** Every stdio MCP server a plugin
  routes (bundled code *or* a bare `npx`/`uvx` that fetches a remote package) is
  installed **off**; an admin reviews and enables it in Extensions. Sandbox
  isolation is the containment; this is informed consent.
- **Upgrades are reviewable.** An upgrade previews the file-level diff between the
  pinned and target commits (flagging changed connector definitions) and applies
  **exactly the reviewed commit**, so a hostile upstream can't swap in a different
  commit between review and apply.

This reduces — it does not eliminate — the risk of running third-party code. Treat
marketplace sources as you would any dependency: install from repos you trust.

## Secret handling

- `UNCLAW_MASTER_KEY` encrypts provider API keys at rest and lives **outside** the
  database, so a DB leak alone cannot decrypt them. 64 hex chars. In production the
  app is **fail-closed**: with no `UNCLAW_MASTER_KEY` it refuses to start rather than
  fall back to a DB-stored key. Set `ALLOW_DB_MASTER_KEY=true` to knowingly accept
  the insecure fallback (dev/testing).
- `CONTROLLER_SECRET` gates the platform↔controller channel; the controller
  refuses to boot on the default value in production.
- `scripts/up.sh` generates strong values into `.env` (mode `600`) on first run
  and never overwrites an operator-set value.

## Known limitations & residual risks

We'd rather state these plainly than imply a stronger posture than ships today.
unClaw is a **self-hosted Docker app for solo operators and small/medium teams**,
with sandboxed execution and a documented hardening path for higher-trust
deployments — not a turnkey-certified multi-tenant platform.

- **Long-running process required.** The agent worker runs **in-process** inside
  the platform container via Next.js instrumentation. unClaw must run as a
  long-lived process (Docker/VM); serverless/edge hosts that freeze between
  requests are unsupported. A separate `worker` service running the same code is a
  planned option, not a current one.
- **Realtime/queue scale boundary.** The task queue and realtime bus are Postgres
  (`SKIP LOCKED` leases + `LISTEN/NOTIFY`). This is deliberately dependency-light
  and right for small/medium load; it is **not** an event-streaming layer (8 KB
  NOTIFY payload limit, single-DB fan-out). Very high concurrency needs a
  different bus.
- **CSP is partial.** The shipped policy is the inline-safe slice (`object-src`,
  `base-uri`, `form-action`, `frame-ancestors`). A strict `script-src` without
  `unsafe-inline` (per-request nonce) is **not yet enabled**, so this is not full
  XSS containment for model/user-generated content.
- **SSRF is narrowed, not fully pinned.** Outbound fetches block private/loopback/
  metadata ranges and strip credentials on cross-host redirects, but DNS-rebinding
  is not yet fully closed (would require connection-level IP pinning). Don't point
  the instance at a network where SSRF to an internal service would be catastrophic
  without additional network-level egress controls.
- **Auth depends on `better-auth`.** A young dependency carries its own advisory
  surface; keep it updated. Enterprise SSO/OIDC/SCIM is a separate commercial
  edition, not in this repo.
- **Docker socket is root-equivalent.** Even via the socket-proxy, only **rootless
  Docker** (or gVisor) makes a container escape *not* equal host root — see above.
- **Audit log is best-effort.** Entries are written after the action, not in the
  same transaction, and a write failure is logged but does not block the action.
  In a DB outage a critical event could go unrecorded. Treat the audit log as
  strong evidence, not a hard guarantee; for compliance, ship logs off-box.
- **Dependency audit has accepted residual advisories.** Fixable ones are pinned
  via `overrides` (postcss, dompurify). The rest are **dev-tooling reaching the
  prod tree through a dependency's loose declarations** — chiefly the `esbuild`
  dev-server advisory (it only affects `esbuild serve`, which a deployed app never
  runs) and a `js-yaml` quadratic-DoS in `gray-matter` frontmatter parsing
  (bounded by the 2 MB fetch cap on plugin/skill files). Their only npm-offered
  "fix" is absurd major downgrades, so they're accepted, not applied. Re-evaluate
  on each dependency bump.

If your threat model exceeds these boundaries, run rootless + gVisor, front the app
with your own WAF/egress controls, and budget for a security review before exposing
it to untrusted users.
