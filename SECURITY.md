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

## Secret handling

- `UNCLAW_MASTER_KEY` encrypts provider API keys at rest and lives **outside** the
  database, so a DB leak alone cannot decrypt them. 64 hex chars.
- `CONTROLLER_SECRET` gates the platform↔controller channel; the controller
  refuses to boot on the default value in production.
- `scripts/up.sh` generates strong values into `.env` (mode `600`) on first run
  and never overwrites an operator-set value.
