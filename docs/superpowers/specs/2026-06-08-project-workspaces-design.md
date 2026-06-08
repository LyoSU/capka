# Project Workspaces (Phase 1) — Design

**Goal:** A project becomes a shared folder: every chat inside a project sees the same
`/workspace` files, shares the project's instructions and memory, and every chat (project
or not) gets access to a per-user global folder at `/shared`.

**Status:** Approved 2026-06-08.

## Motivation

Today the sandbox is keyed by `chatId`. Each chat gets its own Docker container and its own
host folder `data/storage/{userId}/{chatId}/sandbox` mounted at `/workspace`. Files never
carry between chats. The schema already models projects (`chats.projectId`,
`projects.systemPrompt`, `memories.projectId`) but the file layer and memory scoping do not
use it. This closes that gap.

## Decisions (locked)

- **Shared folder, no locking.** When two chats of the same project run tasks at once, they
  share one `/workspace` (one container). Concurrent agents may overwrite each other's files
  — accepted as normal shared-drive semantics. No per-project task serialization.
- **Global files = per-user folder** mounted into every container at `/shared` (read-write),
  in addition to the project/standalone `/workspace`.

## Storage layout (host, owned by sandbox-controller)

```
data/storage/{userId}/
├── _global/sandbox        → mounted as /shared   in EVERY container (RW)
├── {projectId}/sandbox    → mounted as /workspace for all chats of the project
└── {chatId}/sandbox       → mounted as /workspace for a standalone chat (unchanged)
```

`workspaceKey = projectId ?? chatId`. The controller already namespaces every path under
`sanitize(userId)`, so keying by `projectId` stays within the user's subtree — no security
regression. `_global` can never collide with a nanoid id.

## Components changed

1. **`sandbox-controller/server.js`** — add `globalPath(userId)` helper; `createSandbox`
   creates `_global/sandbox` and adds a second bind `${globalPath}:/shared`. File-browsing
   endpoints (`/files`, `/download`, `/upload`) gain an optional `userId` so the platform can
   browse a workspace from the host fs without requiring the container to be live (more
   robust than today's create-session-to-browse), while preserving the session-ownership
   check when a session exists.

2. **`src/lib/sandbox/tools.ts`** — `loadSandboxTools(userId, sessionKey, networkMode)`:
   rename the `chatId` parameter to `sessionKey` (it is no longer always a chat). Behavior
   otherwise unchanged.

3. **`src/lib/sandbox/client.ts`** — no signature change (the session id it forwards is
   already opaque). File ops keep working on whatever key the caller passes.

4. **`src/lib/tasks/runner.ts`** — `prepareRun` computes `sessionKey = payload.projectId ?? chatId`
   and threads it through `loadSandboxTools`, the workspace-snapshot `execCommand`, and
   `injectNativeFiles`/`downloadBounded` (these download attached files from the same key).

5. **Memory scoping (runner)** — load memories
   `WHERE userId AND (projectId = X OR projectId IS NULL)` for a project chat, and
   `WHERE userId AND projectId IS NULL` for a standalone chat (fixes the current cross-project
   leak where all user memories load regardless of project). Extracted facts are tagged with
   the chat's `projectId` (null for standalone).

6. **File API routes** (`src/app/api/sandbox/files/route.ts`, `.../download/route.ts`,
   `.../download-all/route.ts`, `.../upload/route.ts`) — resolve `chatId → projectId ?? chatId`
   via a shared helper and pass that key (plus `userId`) to the controller. The UI
   (`SandboxFiles`) is unchanged: it still posts `chatId`.

7. **`src/lib/chat/prompt.ts`** — `buildSystemPrompt` documents the two mounts: `/workspace`
   (project files, shared across the project's chats) and `/shared` (your global files,
   available in every chat).

## Data flow

```
chat (projectId=P) → enqueueTask(payload.projectId=P)
  → worker claims → prepareRun → sessionKey=P
  → controller mounts data/storage/{u}/P/sandbox:/workspace + {u}/_global/sandbox:/shared
  → every chat of project P sees the same files.

standalone chat → sessionKey=chatId → own /workspace + shared /shared.
```

## Helper: `workspaceSessionKey`

`src/lib/sandbox/workspace.ts` (new):

```ts
/** The sandbox session key for a chat: its project (shared folder) or the chat itself. */
export function workspaceSessionKey(chat: { id: string; projectId: string | null }): string {
  return chat.projectId ?? chat.id;
}
```

Used by the runner (via payload.projectId) and by the file API routes (via the chat row).

## Error handling / edge cases

- **Concurrency:** one container per project; concurrent execs are independent OS processes;
  file overwrites are accepted shared-drive behavior (locked decision).
- **projectId change on a chat:** the workspace key changes, so the chat would point at a
  different folder. Acceptable — chats are created with their project up front; reassignment
  is not a supported flow in this phase.
- **Lazy `_global`:** created on first `createSandbox` for the user; `mkdir -p` is idempotent.
- **Browsing before first run:** file endpoints read host fs by `(userId, sessionKey)`, so a
  project's files are visible even if no container is currently live.

## Testing

- **Unit:** `workspaceSessionKey` (project vs standalone); memory-scope query builder returns
  the right predicate for project vs standalone.
- **Integration (guarded by `RUN_INTEGRATION=1` + Docker):**
  - two sessions sharing one `projectId` see a file written by the other;
  - a standalone session does not see the project's files;
  - a file in `_global` is visible from both a project and a standalone session at `/shared`.

## Out of scope (YAGNI for this phase)

- Cross-project file sharing beyond `_global`.
- Per-project task serialization / locking.
- Moving/reassigning a chat's project after creation.
- A dedicated "Project Files" UI separate from the per-chat file browser.
