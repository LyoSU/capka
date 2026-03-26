# Architecture Refactor — Boundary Cleanup

**Date:** 2026-03-26
**Status:** Approved
**Goal:** Minimal code, maximum reuse, predictable errors, zero manual try-catch in routes.

## Principles

- Routes are thin adapters: auth → parse → call service → return response
- Feature-scoped modules own queries, schemas, and presentation logic
- One source of truth for shared types (Zod schemas → `z.infer<>`)
- Typed errors with safe public messages; raw details logged server-side only
- Generic ownership helpers eliminate per-table `findX(id, userId)` duplicates

## 1. Feature-Scoped Modules

Replace inline Drizzle queries in routes with feature modules:

```
src/lib/chat/
  queries.ts      — findChat, listMessages, createChat, upsertChat
  prompt.ts       — buildSystemPrompt (extracted from chat/route.ts POST)
  presenter.ts    — DB metadata → UIMessage[] (extracted from chat/route.ts GET)
  contracts.ts    — Zod schemas for chat request/response + Part/Message types

src/lib/projects/
  queries.ts      — findProject, listProjects, createProject, updateProject, deleteProject

src/lib/memories/
  queries.ts      — findMemory, listMemories, createMemory, updateMemory, deleteMemory
```

Route files import from these modules. No Drizzle in route files.

## 2. Generic Ownership Helpers

```typescript
// src/lib/db/ownership.ts
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/errors";

// Composable — returns null if not found or not owned
export async function findOwned<T>(
  table: TableWithIdAndUserId,
  id: string,
  userId: string,
  select?: SelectConfig,
): Promise<T | null>

// Throws 404 — for routes that require the resource to exist
export async function requireOwned<T>(
  table: TableWithIdAndUserId,
  id: string,
  userId: string,
  select?: SelectConfig,
): Promise<T>
```

Both query `WHERE id = ? AND userId = ?` in SQL (no fetch-then-check pattern).

Replaces: `findChat()`, `findProject()`, `findMemory()`, `verifyChatOwnership()`.

## 3. Typed Errors

```typescript
// src/lib/errors.ts
export class AppError extends Error {
  status: number;
  code: string;

  toResponse(): Response  // safe message only
  toLog(): string         // full details
}

// Subclasses:
export class NotFoundError extends AppError     // 404
export class ValidationError extends AppError   // 400
export class ForbiddenError extends AppError    // 403
export class SandboxError extends AppError      // 502, adds: operation, retryable
```

`apiHandler` catches `AppError` → calls `toResponse()`. Unknown errors → generic 500 message + `console.error` with full stack. Never expose raw `Error.message` to client.

Replaces: `ApiError` class (renamed to `AppError` for clarity, same pattern but richer).

## 4. Zod Schemas (co-located by feature)

```typescript
// src/lib/chat/contracts.ts
import { z } from "zod";

export const chatRequestSchema = z.object({
  chatId: z.string().optional(),
  model: z.string(),
  projectId: z.string().optional(),
  userMessage: z.string(),
  attachedFiles: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
  messages: z.array(z.any()).optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

// Shared Part types — single source of truth for server, client, runner
export const storedPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool-call"), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool-result"), id: z.string(), name: z.string(), output: z.unknown() }),
  z.object({ type: z.literal("tool-error"), id: z.string(), name: z.string(), error: z.string() }),
]);
export type StoredPart = z.infer<typeof storedPartSchema>;
```

Replaces: inline `type StoredPart`, `type ToolMeta` in chat/route.ts, `type PartEntry` in runner.ts, `type Part` in use-background-chat.ts.

## 5. Split chat/route.ts

Current (231 LOC, mixed concerns):
- POST: auth, parallel data load, chat upsert, prompt build, task creation
- GET: auth, ownership check, message load, metadata→UIMessage mapping

After:
- `chat/route.ts` POST: ~30 LOC — auth, parse body with Zod, call modules, return taskId
- `chat/route.ts` GET: ~15 LOC — auth, call presenter, return UIMessages
- `lib/chat/prompt.ts`: system prompt assembly (~40 LOC)
- `lib/chat/presenter.ts`: metadata→UIMessage mapping (~60 LOC)
- `lib/chat/queries.ts`: DB operations (~30 LOC)
- `lib/chat/contracts.ts`: Zod schemas + types (~40 LOC)

## 6. Remaining Routes → apiHandler

Convert sandbox file routes, models, events, setup to use `apiHandler`.

## 7. Sandbox Client — Structured Errors

```typescript
// In sandbox/client.ts
export class SandboxError extends AppError {
  operation: string;     // "exec" | "upload" | "download" | "create"
  retryable: boolean;
}
```

Replaces: `throw new Error("Sandbox: ...")`.

## Migration Strategy

Incremental — each step is independently deployable:

1. Create `lib/errors.ts` with typed errors, update `apiHandler`
2. Create `lib/db/ownership.ts`, replace findX duplicates
3. Create `lib/chat/contracts.ts` with shared Zod schemas
4. Extract `lib/chat/prompt.ts` and `lib/chat/presenter.ts`
5. Create feature queries modules (chat, projects, memories)
6. Thin out route files to use modules
7. Convert remaining routes to `apiHandler`
8. Update sandbox client to throw `SandboxError`
9. Update client-side types to import from contracts

## Non-Goals

- No repository pattern / ORM abstraction layer
- No API path changes (keep current URLs)
- No new dependencies (Zod already in project)
- No horizontal scaling changes (runner/eventBus stay in-memory for now)
