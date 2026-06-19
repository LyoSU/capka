# Changelog

All notable changes to unClaw are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- AGPL-3.0 license; `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, CLA.
- One-variable automatic HTTPS via the Caddy TLS overlay (`DOMAIN=…`).
- Railway and Coolify deploy templates.
- Postgres backup/restore scripts and an optional scheduled-backup overlay.
- `UNCLAW_VERSION` image pinning and an upgrade runbook (`docs/UPGRADE.md`).
- `ee/` boundary reserved for the commercial edition.

### Changed
- The host-agnostic `docker-compose.yml` is now the canonical compose; the
  Coolify variant moved to `docker-compose.coolify.yml` (no longer auto-selected).
- `docker compose pull` now fetches the sandbox image from GHCR too.
