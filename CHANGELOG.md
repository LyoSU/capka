# Changelog

All notable changes to Capka are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- The "update available" banner is now **dismissible** — a close button hides it
  and remembers the release, so it stays gone for that version but returns when a
  newer one ships (it previously reappeared on every page load with no way to
  silence it).
- Release notes on **Settings → Updates** now render as Markdown (via the same
  renderer the chat uses) instead of raw preformatted text, and the "how to update"
  hint is trimmed.

## [0.1.3] - 2026-07-01

### Fixed
- **Completes the gVisor egress fix** (0.1.2 was still partial). Two more pieces,
  both automatic — **no config/env change needed**:
  - iptables-legacy needs a writable lock, but the sandbox rootfs is read-only and
    `/run` isn't a writable mount, so the firewall died on `/run/xtables.lock`. The
    controller now points it at the writable `/tmp` tmpfs (`XTABLES_LOCKFILE`),
    set automatically only when egress is on.
  - a crashed sandbox container left its fixed name behind, so recreating the
    session failed with a 409 name conflict forever. The controller now
    force-removes the stale husk and retries.

## [0.1.2] - 2026-07-01

### Fixed
- **Sandbox egress under gVisor no longer kills every container.** With
  `SANDBOX_ALLOW_NETWORK=true` on the `runsc` profile, the fail-closed egress
  firewall (added in 0.1.0) could not install its iptables rules and exited the
  container the instant it started — so every command failed. Three pieces were
  needed: the image pins iptables to the **legacy** backend gVisor speaks (not
  nft); the controller grants the sandbox **NET_RAW** alongside NET_ADMIN so the
  rules' `filter` table can initialize under `CapDrop: ALL`; and
  `scripts/install-gvisor.sh` registers the runtime with **`--net-raw=true`** so
  gVisor honors that capability. **Existing gVisor hosts must re-run the install
  script (or add `--net-raw=true` to the runsc `runtimeArgs`) and reload Docker.**
- Controller now recovers from a present-but-stopped sandbox container, not only a
  removed one: a stale handle is invalidated so the session is recreated instead of
  looping on "container is not running".

## [0.1.1] - 2026-07-01

Partial gVisor egress fix (legacy iptables backend in the image + the
`--net-raw=true` install step) — **superseded by 0.1.2**, which adds the missing
`NET_RAW` container capability without which the firewall still fails. Use 0.1.2.

## [0.1.0] - 2026-06-30

> **⚠ Breaking — sandbox network egress is now fail-closed.** Sandboxes have
> **no outbound network** unless you explicitly set `SANDBOX_ALLOW_NETWORK=true`.
> Deployments that relied on sandboxes reaching the internet (package installs,
> scraping, outbound API calls from agent code) **must add this variable** or that
> traffic silently stops. This closes an egress-by-default hole; opt back in only
> if you understand the exposure (see `SECURITY.md`).

### Added
- AGPL-3.0 license; `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, CLA.
- One-variable automatic HTTPS via the Caddy TLS overlay (`DOMAIN=…`).
- Railway and Coolify deploy templates.
- Postgres backup/restore scripts and an optional scheduled-backup overlay.
- `CAPKA_VERSION` image pinning and an upgrade runbook (`docs/UPGRADE.md`).
- `ee/` boundary reserved for the commercial edition.
- Marketplace install review: every plugin install is **pinned to a concrete git
  commit** (provenance recorded), all third-party code execution is **disabled by
  default** pending admin review, and upgrades show a **file-level diff bound to the
  reviewed commit** before the pin is moved.
- Boot-time configuration audit: misconfigured/missing env (master key,
  `DATABASE_URL`, public URL, numeric knobs) is surfaced as one block at startup.
- A Content-Security-Policy (the inline-safe slice: `object-src`, `base-uri`,
  `form-action`, `frame-ancestors`).

### Changed
- The host-agnostic `docker-compose.yml` is now the canonical compose; the
  Coolify variant moved to `docker-compose.coolify.yml` (no longer auto-selected).
- `docker compose pull` now fetches the sandbox image from GHCR too.
- Sandbox image: base image is an overridable `UBUNTU_REF` arg and the duckdb/yq
  CLIs are pinned to explicit versions (were `releases/latest`, non-reproducible).

### Security
- **Sandbox egress fail-closed** behind `SANDBOX_ALLOW_NETWORK` (see breaking note
  above); the egress firewall refuses to start if its rules can't be verified.
- Governance `ask` now fails **safe** (deny) instead of allowing.
- SSRF guard broadened (0.0.0.0 / multicast / IPv6) and strips `Authorization`/
  `Cookie` on cross-host redirects; the private-range block is threaded into the
  inference fetch path. (Full DNS-rebind IP-pinning is still pending — see
  `SECURITY.md` → Known limitations.)
- Zip uploads get a decompression-bomb guard: entries inflate under a hard
  `maxOutputLength` cap, so a lying header can't expand a small upload to gigabytes.
- Foreign keys + money-column precision added (`drizzle/0034`, `0035`); audit log
  extended to admin role/status/remove, auth-config, and master-key actions.
- Billing holds are always released (try/finally); first-run setup can no longer be
  hijacked to self-promote admin; pending accounts are rejected centrally.
- Dependency advisories pinned where a non-breaking fix exists: `postcss` ≥8.5.10
  (CSS-stringify XSS) and `dompurify` ≥3.4.11 via `overrides` (was 12 prod
  advisories, now the remainder are dev-tooling only — see `SECURITY.md`).
- Account status is fail-closed (only "active" grants access); marketplace upgrade
  consent is fail-closed (must target the reviewed commit); MCP connector mutations
  require an approved account; one billing hold per task (partial unique index);
  marketplace raw fetches and catalog size are byte/count-capped.
- **Production master key is fail-closed**: with `NODE_ENV=production` and no
  `CAPKA_MASTER_KEY`, the app now refuses to start rather than silently storing the
  key in the DB. Set `CAPKA_MASTER_KEY` (recommended) or `ALLOW_DB_MASTER_KEY=true`
  to knowingly keep the insecure fallback. (`npm run up` already generates the env
  key, so turnkey deploys are unaffected.)
- HSTS is now sent by the platform too, not only the Caddy TLS profile.
