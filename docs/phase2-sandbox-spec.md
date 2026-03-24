# Phase 2: Sandbox Code Execution

## Architecture

```
Platform (Next.js) ──HTTP──► sandbox-controller (Docker service)
                                    │ Docker Engine API
                                    ▼
                              sandbox-{chatId} containers
                              Ubuntu + Python + Node.js + Playwright
                              per-chat isolation, stateful workspace
```

## Sandbox Controller Service
- Separate Docker Compose service with narrow HTTP API
- Only it has access to Docker socket — platform never touches it
- Endpoints: POST /sessions, POST /sessions/:id/exec, GET /sessions/:id/files, DELETE /sessions/:id

## Sandbox Image (Dockerfile.sandbox)
- Ubuntu 22.04 slim base
- Python 3.12 + pip, Node.js 22 + npm
- Bash, git, curl, ripgrep, jq
- Chromium + Playwright (browser automation)
- Non-root user, /workspace mount

## AI SDK Tools
1. sandbox_exec — bash command with timeout
2. sandbox_read / sandbox_write — file operations
3. sandbox_list — directory listing
4. sandbox_search — grep/ripgrep
5. sandbox_browser — open URL, screenshot, click (Phase 2b)

## Security
- Network: none by default, allowlist for npm/git
- CapDrop ALL, no-new-privileges, non-root
- PID limit 100, Memory 512MB, CPU 1.0
- Per-command timeout 30s, per-session budget
- Audit logging every action to DB

## Container Lifecycle
- Per-chat containers (not per-user)
- Idle cleanup after 15 min
- DB-backed session leases
- Workspace persisted in data/storage/{userId}/{chatId}/sandbox/

## Enterprise
- Configurable limits via settings UI
- Audit log table
- Admin-approved sandbox images only
- Session tracking table
