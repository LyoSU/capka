# Project Workspaces Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Project = shared folder. All chats of a project share `/workspace`; every chat gets a per-user `/shared`. Memory scoped per project.

**Architecture:** `workspaceKey = projectId ?? chatId` threaded from the runner and file APIs into the sandbox-controller, which mounts the per-key folder at `/workspace` and a per-user `_global` folder at `/shared`.

**Tech Stack:** Next.js 16, Drizzle/Postgres, Node sandbox-controller (dockerode), vitest.

---

### Task 1: `workspaceSessionKey` helper + unit test

**Files:**
- Create: `src/lib/sandbox/workspace.ts`
- Test: `src/lib/__tests__/workspace.test.ts`

- [ ] **Step 1:** Write `src/lib/sandbox/workspace.ts`:

```ts
/** The sandbox session key for a chat: its project (shared folder) or the chat itself. */
export function workspaceSessionKey(chat: { id: string; projectId: string | null }): string {
  return chat.projectId ?? chat.id;
}
```

- [ ] **Step 2:** Test both branches (project → projectId; null → id). Run vitest; expect PASS.
- [ ] **Step 3:** Commit.

### Task 2: Controller — `/shared` mount + host-fs file browsing

**Files:**
- Modify: `sandbox-controller/server.js`

- [ ] **Step 1:** Add `globalPath(userId)` → `resolve(DATA_ROOT, sanitize(userId), "_global", "sandbox")`.
- [ ] **Step 2:** In `createSandbox`: `await mkdir(globalPath(userId), { recursive: true })` and add bind `${globalPath(userId)}:/shared` to `HostConfig.Binds`.
- [ ] **Step 3:** `/files`, `/download`, `/upload` GET/POST handlers: resolve the workspace base from the active session if present, else from `userId` query/field param (`workspacePath(userId, sessionId)`), so browsing works without a live container. Keep the 403 ownership check when a session exists.
- [ ] **Step 4:** Manual smoke via curl against a running controller (or covered by Task 7 integration). Commit.

### Task 3: `tools.ts` — rename `chatId` → `sessionKey`

**Files:**
- Modify: `src/lib/sandbox/tools.ts`

- [ ] **Step 1:** `loadSandboxTools(userId, sessionKey, networkMode)`; replace `chatId` usages (`createSession`, `run`) with `sessionKey`.
- [ ] **Step 2:** Typecheck. Commit.

### Task 4: `runner.ts` — sessionKey threading + memory scoping

**Files:**
- Modify: `src/lib/tasks/runner.ts`

- [ ] **Step 1:** In `prepareRun`, compute `const sessionKey = payload.projectId ?? chatId;` and use it for `loadSandboxTools`, the snapshot `execCommand`, and pass it to `injectNativeFiles`/`downloadBounded` (rename their `chatId` param to `sessionKey`).
- [ ] **Step 2:** Memory load: `WHERE userId AND (projectId = X OR projectId IS NULL)` when `payload.projectId`, else `WHERE userId AND projectId IS NULL`. Use drizzle `and`/`or`/`eq`/`isNull`.
- [ ] **Step 3:** Memory extraction insert: tag `projectId: payload.projectId ?? null`.
- [ ] **Step 4:** Typecheck. Commit.

### Task 5: File API routes — resolve key

**Files:**
- Modify: `src/app/api/sandbox/files/route.ts`, `.../files/download/route.ts`, `.../files/download-all/route.ts`, `.../files/upload/route.ts`

- [ ] **Step 1:** In each, `const chat = await requireOwned(chats, chatId, userId, "Chat")`; `const key = workspaceSessionKey({ id: chatId, projectId: (chat.projectId as string | null) ?? null });` then pass `key` (and `userId`) to the client/controller calls instead of `chatId`.
- [ ] **Step 2:** Typecheck. Commit.

### Task 6: Prompt — document mounts

**Files:**
- Modify: `src/lib/chat/prompt.ts`

- [ ] **Step 1:** Add a sentence to the system prompt: `/workspace` = project files shared across the project's chats; `/shared` = your global files available in every chat.
- [ ] **Step 2:** Typecheck. Commit.

### Task 7: Integration tests

**Files:**
- Create: `src/lib/sandbox/__tests__/workspaces.integration.test.ts`

- [ ] **Step 1:** Guard with `RUN_INTEGRATION=1`; require a running controller. Two sessions sharing a `projectId` (use the same key) — write a file via one, list/read via the other; assert visible.
- [ ] **Step 2:** Standalone session (different key) does not see the project file.
- [ ] **Step 3:** Write into `_global` (via `/shared`) from one session, read `/shared` from another; assert visible.
- [ ] **Step 4:** Run guarded suite locally; commit.

### Task 8: Full verification + merge

- [ ] **Step 1:** `node_modules/.bin/tsc --noEmit`, lint, `node_modules/.bin/vitest run` (unit). Expect green.
- [ ] **Step 2:** Update memory `unclaw-phase0-status.md` / add Phase 1 note.
- [ ] **Step 3:** Commit; merge to master.
