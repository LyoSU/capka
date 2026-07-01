<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Changelog conventions

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) +
[SemVer](https://semver.org/). When a change is user- or operator-visible, add an
entry under `## [Unreleased]` in the same commit/PR — don't batch it for later.

- **Categorize**: `### Added` / `### Changed` / `### Fixed` / `### Security` /
  `### Deprecated` / `### Removed`, in that order. Only include a heading if it
  has entries; add the heading if it doesn't exist yet under Unreleased.
- **Audience**: the people who deploy and run Capka (self-hosters/admins), not
  end-users chatting with it. Reference env vars, config, files, and behavior by
  name.
- **Write what broke and what changed, not "fixed bug"**: lead with a **bolded
  one-line summary** of the user-visible effect, then explain the concrete OLD
  behavior (what was wrong and why) and the NEW behavior. A reader should be able
  to judge whether this affects their deployment without reading the diff.
  - Good: "**Sandbox egress under gVisor no longer kills every container.** ...
    the fail-closed egress firewall could not install its iptables rules and
    exited the container the instant it started ... Three pieces were needed: ..."
  - Bad: "Fixed a bug with sandbox egress."
- **Breaking changes**: add a `> **⚠ Breaking — ...**` blockquote directly under
  the version heading (not buried in a bullet), stating exactly what breaks and
  the required action (e.g. "must set `SANDBOX_ALLOW_NETWORK=true`").
- **No marketing language, no emoji outside the ⚠ breaking-change marker.** Plain,
  precise, technical — match the terse density of existing entries.
- Cutting a release renames `[Unreleased]` to `## [x.y.z] - YYYY-MM-DD` and opens
  a fresh empty `[Unreleased]`.
