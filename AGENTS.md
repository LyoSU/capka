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
- **One line per entry, not a paragraph.** State the user-visible effect and, if
  needed, the required action (env var, redeploy, migration) — that's it. No
  backstory on the old broken behavior, no internal root-cause walkthrough, no
  mechanism explanation. That detail belongs in the commit message/PR
  description, not the changelog. If an entry needs a second sentence to name a
  required action, that's the max — never three.
  - Good: "Sandbox egress under gVisor no longer kills every container
    (iptables-legacy + NET_RAW). Existing gVisor hosts: re-run
    `install-gvisor.sh` and reload Docker."
  - Bad: "Fixed a bug with sandbox egress."
  - Also bad: a multi-sentence essay on what the old firewall code did wrong,
    why, and how the fix works internally.
- **Breaking changes**: add a `> **⚠ Breaking — ...**` blockquote directly under
  the version heading (not buried in a bullet), stating exactly what breaks and
  the required action (e.g. "must set `SANDBOX_ALLOW_NETWORK=true`"). One line.
- **No marketing language, no emoji outside the ⚠ breaking-change marker.** Plain,
  precise, terse.
- Cutting a release renames `[Unreleased]` to `## [x.y.z] - YYYY-MM-DD` and opens
  a fresh empty `[Unreleased]`.
