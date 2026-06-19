# unClaw Enterprise Edition (reserved)

This directory is reserved for the **commercial edition** of unClaw. It is **not**
covered by the repository's AGPL-3.0 license — see `ee/LICENSE`.

## What lives here (when built)

- SSO / OIDC and SCIM provisioning
- Advanced RBAC (custom roles/policies beyond the core admin/user + allow/ask/deny)
- Helm chart / Kubernetes packaging
- Observability integrations (metrics/traces exporters)
- Audit-log export & retention

## The boundary rule

The AGPL core in `src/**` must **never import from `ee/**`**. EE features attach
through extension points the core exposes (plugin/registry interfaces), so the
core remains fully functional and shippable as open source on its own. This is
enforced by a lint rule (see `eslint.config.mjs`).

Currently empty by design.
