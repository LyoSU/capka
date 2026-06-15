# MCP Client + Connectors (B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the agent to remote MCP servers (Streamable HTTP) and merge their tools into the loop alongside the sandbox and skill tools, with scope-bound encrypted credentials.

**Architecture:** Official `@modelcontextprotocol/sdk` Client over `StreamableHTTPClientTransport` (auth via a custom `fetch` that injects header secrets) → each MCP tool wrapped as an AI SDK `dynamicTool`, namespaced `mcp__<server>__<tool>` → merged into the `prepareRun` tools record (stable order for cache). Servers stored per scope (system=org / user / project) with AES-GCM-encrypted secrets; URLs SSRF-guarded. A dead server is skipped, never fatal.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, AI SDK 6 (`dynamicTool`/`jsonSchema`), Drizzle/Postgres, `src/lib/crypto.ts`, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-15-mcp-client-design.md`. **Scope note:** B1 implements `http` (Streamable HTTP) transport only — `sse` (legacy/deprecated) and `stdio` (B2) are stored-but-rejected by the service.

---

## File Structure

**New**
- `src/lib/net/ssrf.ts` — shared SSRF guard (`assertSafeUrl`, `isBlockedAddress`), extracted from `list-models.ts`.
- `src/lib/mcp/types.ts` — `McpScope`, `McpTransport`, `McpSecrets`, `McpServerConfig`, `McpServerInfo`.
- `src/lib/mcp/adapt.ts` — `mcpToolName`, `adaptMcpTool`.
- `src/lib/mcp/client.ts` — `connectMcpServer`.
- `src/lib/mcp/service.ts` — `listEnabledServers`, `dedupeServersByPrecedence`, `getServer`, `upsertServer`, `deleteServer`, secret encrypt/decrypt.
- `src/lib/mcp/load.ts` — `loadMcpTools`.
- `src/lib/mcp/__tests__/adapt.test.ts`, `service.test.ts`.
- `src/lib/net/__tests__/ssrf.test.ts`.
- `src/app/api/mcp/route.ts` — user CRUD (own user-scope servers) + list.
- `src/app/api/admin/mcp/route.ts` — admin CRUD (system/project servers).
- `src/app/(dashboard)/settings/connectors/page.tsx` — connectors UI (list + add + toggle).

**Modify**
- `package.json` — add `@modelcontextprotocol/sdk`.
- `src/lib/db/schema.ts` — add `mcp_servers` table.
- `src/lib/providers/list-models.ts` — use the extracted `ssrf.ts`.
- `src/lib/tasks/runner.ts` — load + merge MCP tools; close them.
- `src/app/(dashboard)/settings/layout.tsx` — add "Connectors" nav.
- `messages/en.json`, `messages/uk.json` — i18n.

Run one test file: `npx vitest run <path>`; whole suite: `npx vitest run`.

---

## Task 0: Dependency

**Files:** `package.json`

- [ ] **Step 1: Install the MCP SDK**

Run: `npm install @modelcontextprotocol/sdk`
Expected: it appears in `dependencies`.

- [ ] **Step 2: Verify the suite still passes**

Run: `npx vitest run`
Expected: existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(mcp): add @modelcontextprotocol/sdk"
```

---

## Task 1: Extract the SSRF guard to a shared module

**Files:**
- Create: `src/lib/net/ssrf.ts`
- Create: `src/lib/net/__tests__/ssrf.test.ts`
- Modify: `src/lib/providers/list-models.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/net/__tests__/ssrf.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isBlockedAddress } from "../ssrf";

describe("isBlockedAddress", () => {
  it("always blocks link-local / cloud metadata", () => {
    expect(isBlockedAddress("169.254.169.254", false)).toBe(true);
    expect(isBlockedAddress("fe80::1", false)).toBe(true);
  });
  it("allows private ranges unless blockPrivate", () => {
    expect(isBlockedAddress("10.0.0.1", false)).toBe(false);
    expect(isBlockedAddress("10.0.0.1", true)).toBe(true);
    expect(isBlockedAddress("127.0.0.1", true)).toBe(true);
  });
  it("allows public addresses", () => {
    expect(isBlockedAddress("1.1.1.1", true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/net/__tests__/ssrf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/net/ssrf.ts`** (moved verbatim from `list-models.ts`, now exported)

```ts
import { isIPv4 } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * SSRF guard for user-supplied URLs (provider base URLs, MCP server URLs).
 * Link-local / cloud-metadata (169.254/16, fe80::/10) are ALWAYS blocked.
 * Loopback + private ranges are allowed by default (self-hosted gateways),
 * blocked when the admin opts into the stricter policy. Resolves DNS so a
 * public hostname can't point at an internal address.
 */
export function isBlockedAddress(ip: string, blockPrivate: boolean): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIPv4(v4)) {
    const o = v4.split(".").map(Number);
    if (o[0] === 169 && o[1] === 254) return true;
    if (!blockPrivate) return false;
    if (o[0] === 127) return true;
    if (o[0] === 10) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (/^fe[89ab]/.test(lower)) return true;
  if (!blockPrivate) return false;
  if (lower === "::1") return true;
  if (/^f[cd]/.test(lower)) return true;
  return false;
}

export async function assertSafeUrl(raw: string, blockPrivate: boolean): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(u.hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${u.hostname}`);
  }
  for (const { address } of addrs) {
    if (isBlockedAddress(address, blockPrivate)) {
      throw new Error("That address isn't allowed. Check the URL or ask your admin about network restrictions.");
    }
  }
}
```

- [ ] **Step 4: Rewire `list-models.ts` to use it**

In `src/lib/providers/list-models.ts`: delete the local `isBlockedAddress` and `assertSafeProviderUrl` functions and their now-unused `isIPv4`/`lookup` imports; add `import { assertSafeUrl } from "@/lib/net/ssrf";`. In `assertSafeProviderConfig`, replace the call `await assertSafeProviderUrl(baseUrl, …)` with `await assertSafeUrl(baseUrl, …)`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/lib/net/__tests__/ssrf.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: ssrf tests PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/net/ src/lib/providers/list-models.ts
git commit -m "refactor(net): extract shared SSRF guard (assertSafeUrl) for reuse"
```

---

## Task 2: Types

**Files:** Create `src/lib/mcp/types.ts`

- [ ] **Step 1: Write the types**

```ts
import type { SecretDescriptor } from "@/lib/skills/types";

export type McpScope = "system" | "user" | "project";
export type McpTransport = "http" | "sse" | "stdio"; // B1 implements 'http' only

/** Decrypted secrets used at connect time. `env` is for stdio (B2). */
export interface McpSecrets {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/** Runtime config after decryption — what connectMcpServer needs. */
export interface McpServerConfig {
  name: string;
  transport: McpTransport;
  url: string;
  secrets?: McpSecrets;
}

/** A server row as served to load/UI (no decrypted secrets). */
export interface McpServerInfo {
  id: string;
  scope: McpScope;
  name: string;
  transport: McpTransport;
  url: string | null;
  enabled: boolean;
}

/** Forward-compat seam: connectors declare required secrets for the catalog. */
export type { SecretDescriptor };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mcp/types.ts
git commit -m "feat(mcp): shared types (scope, transport, secrets, config)"
```

---

## Task 3: Tool adapter (MCP tool → AI SDK dynamicTool)

**Files:**
- Create: `src/lib/mcp/adapt.ts`
- Test: `src/lib/mcp/__tests__/adapt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { mcpToolName, adaptMcpTool } from "../adapt";

describe("mcpToolName", () => {
  it("namespaces server + tool", () => {
    expect(mcpToolName("notion", "search")).toBe("mcp__notion__search");
  });
});

describe("adaptMcpTool", () => {
  it("wraps an MCP tool and routes execute to callTool", async () => {
    const client = { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) };
    const t = adaptMcpTool(client as never, "notion", {
      name: "search",
      description: "Search Notion",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    });
    expect(t.description).toBe("Search Notion");
    // dynamic tools carry their input schema
    expect(t.inputSchema).toBeDefined();
    const out = await t.execute!({ q: "hi" }, { toolCallId: "1", messages: [] } as never);
    expect(client.callTool).toHaveBeenCalledWith({ name: "search", arguments: { q: "hi" } });
    expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/mcp/__tests__/adapt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { dynamicTool, jsonSchema } from "ai";

/** Minimal shape we need from an MCP client + tool (avoids SDK type coupling). */
interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
interface McpCaller {
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Wrap one MCP tool as an AI SDK dynamic tool (schema known at runtime). */
export function adaptMcpTool(client: McpCaller, serverName: string, mcpTool: McpToolDef) {
  return dynamicTool({
    description: mcpTool.description ?? `${serverName} ${mcpTool.name}`,
    inputSchema: jsonSchema((mcpTool.inputSchema ?? { type: "object", properties: {} }) as never),
    execute: async (input) =>
      client.callTool({ name: mcpTool.name, arguments: (input ?? {}) as Record<string, unknown> }),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mcp/__tests__/adapt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/adapt.ts src/lib/mcp/__tests__/adapt.test.ts
git commit -m "feat(mcp): adapt MCP tools to AI SDK dynamicTool with namespacing"
```

---

## Task 4: Database schema + migration

**Files:** Modify `src/lib/db/schema.ts`; generate migration.

- [ ] **Step 1: Append the table** (after `skillFiles`)

```ts
export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(), // 'system' | 'user' | 'project'
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // namespace ^[a-z0-9]+(-[a-z0-9]+)*$
  transport: text("transport").notNull().default("http"), // 'http' | 'sse' | 'stdio'
  url: text("url"),
  command: text("command"), // stdio (B2)
  args: jsonb("args").$type<string[]>().default([]),
  secrets: text("secrets"), // AES-GCM ciphertext of { headers?, env? }
  enabled: boolean("enabled").notNull().default(true),
  source: text("source").notNull().default("manual"), // 'manual' | 'catalog:<id>'
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_mcp_servers_user_id").on(table.userId),
  index("idx_mcp_servers_project_id").on(table.projectId),
  index("idx_mcp_servers_scope").on(table.scope),
]);
```

- [ ] **Step 2: Generate the migration**

Run: `./node_modules/.bin/drizzle-kit generate`
Expected: a new `drizzle/00NN_*.sql` with `CREATE TABLE "mcp_servers"`. Open it and confirm.

- [ ] **Step 3: Commit**

```bash
git add src/lib/db/schema.ts drizzle/
git commit -m "feat(mcp): mcp_servers table and migration"
```

> Migration applies on `npm run docker:dev` (or `./node_modules/.bin/drizzle-kit migrate` against a running Postgres).

---

## Task 5: Service — scope precedence, CRUD, secret crypto

**Files:**
- Create: `src/lib/mcp/service.ts`
- Test: `src/lib/mcp/__tests__/service.test.ts`

- [ ] **Step 1: Write the failing test (pure dedupe)**

```ts
import { describe, it, expect } from "vitest";
import { dedupeServersByPrecedence } from "../service";
import type { McpServerInfo } from "../types";

const s = (o: Partial<McpServerInfo>): McpServerInfo => ({
  id: o.name ?? "id", scope: "system", name: "x", transport: "http",
  url: "https://e.x/mcp", enabled: true, ...o,
});

describe("dedupeServersByPrecedence", () => {
  it("project beats user beats system", () => {
    const out = dedupeServersByPrecedence([
      s({ id: "sys", scope: "system", name: "dup" }),
      s({ id: "usr", scope: "user", name: "dup" }),
      s({ id: "prj", scope: "project", name: "dup" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("prj");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/mcp/__tests__/service.test.ts`
Expected: FAIL — not found.

- [ ] **Step 3: Implement the service**

```ts
import { and, eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";
import { getMasterKey, getBlockPrivateProviderUrls } from "@/lib/settings";
import { assertSafeUrl } from "@/lib/net/ssrf";
import type { McpScope, McpSecrets, McpServerConfig, McpServerInfo } from "./types";

const SCOPE_RANK: Record<McpScope, number> = { system: 0, user: 1, project: 2 };
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function toInfo(r: typeof mcpServers.$inferSelect): McpServerInfo {
  return { id: r.id, scope: r.scope as McpScope, name: r.name, transport: r.transport as McpServerInfo["transport"], url: r.url, enabled: r.enabled };
}

export function dedupeServersByPrecedence(list: McpServerInfo[]): McpServerInfo[] {
  const byName = new Map<string, McpServerInfo>();
  for (const item of list) {
    const cur = byName.get(item.name);
    if (!cur || SCOPE_RANK[item.scope] > SCOPE_RANK[cur.scope]) byName.set(item.name, item);
  }
  return [...byName.values()];
}

/** Enabled servers visible to this run, with decrypted config (for load.ts). */
export async function listEnabledServerConfigs(userId: string, projectId?: string | null): Promise<McpServerConfig[]> {
  const filter = projectId
    ? or(
        eq(mcpServers.scope, "system"),
        and(eq(mcpServers.scope, "user"), eq(mcpServers.userId, userId), isNull(mcpServers.projectId)),
        and(eq(mcpServers.scope, "project"), eq(mcpServers.projectId, projectId)),
      )
    : or(
        eq(mcpServers.scope, "system"),
        and(eq(mcpServers.scope, "user"), eq(mcpServers.userId, userId), isNull(mcpServers.projectId)),
      );
  const rows = await db.select().from(mcpServers).where(and(eq(mcpServers.enabled, true), filter));
  const winners = dedupeServersByPrecedence(rows.map(toInfo));
  const winnerIds = new Set(winners.map((w) => w.id));
  const key = await getMasterKey();
  const out: McpServerConfig[] = [];
  for (const r of rows) {
    if (!winnerIds.has(r.id) || r.transport !== "http" || !r.url) continue;
    let secrets: McpSecrets | undefined;
    if (r.secrets) {
      try { secrets = JSON.parse(decrypt(r.secrets, key)) as McpSecrets; } catch { secrets = undefined; }
    }
    out.push({ name: r.name, transport: "http", url: r.url, secrets });
  }
  return out;
}

/** For the UI/API — no secrets. */
export async function listServers(userId: string, projectId?: string | null): Promise<McpServerInfo[]> {
  const rows = await db
    .select().from(mcpServers)
    .where(projectId
      ? or(eq(mcpServers.userId, userId), eq(mcpServers.scope, "system"), eq(mcpServers.projectId, projectId))
      : or(eq(mcpServers.userId, userId), eq(mcpServers.scope, "system")));
  return rows.map(toInfo);
}

export interface UpsertServerInput {
  id?: string;
  scope: McpScope;
  userId: string | null;
  projectId: string | null;
  name: string;
  url: string;
  secrets?: McpSecrets;
}

export async function upsertServer(input: UpsertServerInput): Promise<string> {
  if (!NAME_RE.test(input.name)) throw new Error("Invalid connector name");
  await assertSafeUrl(input.url, await getBlockPrivateProviderUrls());
  const key = await getMasterKey();
  const id = input.id ?? nanoid();
  const values = {
    id, scope: input.scope, userId: input.userId, projectId: input.projectId,
    name: input.name, transport: "http" as const, url: input.url,
    secrets: input.secrets ? encrypt(JSON.stringify(input.secrets), key) : null,
    updatedAt: new Date(),
  };
  const existing = input.id
    ? await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.id, input.id)).limit(1)
    : [];
  if (existing[0]) await db.update(mcpServers).set(values).where(eq(mcpServers.id, id));
  else await db.insert(mcpServers).values(values);
  return id;
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  await db.update(mcpServers).set({ enabled, updatedAt: new Date() }).where(eq(mcpServers.id, id));
}

export async function deleteServer(id: string): Promise<void> {
  await db.delete(mcpServers).where(eq(mcpServers.id, id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mcp/__tests__/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.
```bash
git add src/lib/mcp/service.ts src/lib/mcp/__tests__/service.test.ts
git commit -m "feat(mcp): service — scope precedence, CRUD, encrypted secrets, SSRF guard"
```

---

## Task 6: Client — connect to a remote MCP server

**Files:** Create `src/lib/mcp/client.ts`

No unit test (needs a live/in-memory server — covered by the integration check in Task 9). API verified against `@modelcontextprotocol/sdk` docs.

- [ ] **Step 1: Implement**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "./types";

export interface ConnectedMcp {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
}

/** Connect to a remote MCP server and list its tools. Auth headers are injected
 *  via a custom fetch (the documented way to add headers to the transport). */
export async function connectMcpServer(cfg: McpServerConfig): Promise<ConnectedMcp> {
  const headers = cfg.secrets?.headers ?? {};
  const authedFetch: typeof fetch = (input, init) => {
    const h = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    return fetch(input, { ...init, headers: h });
  };

  const client = new Client({ name: "unclaw", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), { fetch: authedFetch });
  await client.connect(transport);
  const listed = await client.listTools();
  return { client, transport, tools: listed.tools as ConnectedMcp["tools"] };
}

export async function disconnectMcp(c: ConnectedMcp): Promise<void> {
  try { await c.transport.terminateSession(); } catch { /* server may not support it */ }
  await c.client.close();
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.
```bash
git add src/lib/mcp/client.ts
git commit -m "feat(mcp): StreamableHTTP client with header auth + listTools"
```

---

## Task 7: Loader — connect all enabled servers, merge tools

**Files:** Create `src/lib/mcp/load.ts`

- [ ] **Step 1: Implement**

```ts
import type { Tool } from "ai";
import { connectMcpServer, disconnectMcp, type ConnectedMcp } from "./client";
import { adaptMcpTool, mcpToolName } from "./adapt";
import { listEnabledServerConfigs } from "./service";

const MAX_CONCURRENT = 4;

/** Connect every enabled server (bounded concurrency), adapt + namespace their
 *  tools. A server that fails is logged and skipped — never fatal. Tools are
 *  collected in deterministic order (servers by name, tools by name) so the
 *  position-0 tool prefix stays cache-stable. */
export async function loadMcpTools(opts: { userId: string; projectId: string | null }): Promise<{
  tools: Record<string, Tool>;
  close: () => Promise<void>;
}> {
  const configs = (await listEnabledServerConfigs(opts.userId, opts.projectId)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const connected: ConnectedMcp[] = [];
  const tools: Record<string, Tool> = {};

  for (let i = 0; i < configs.length; i += MAX_CONCURRENT) {
    const batch = configs.slice(i, i + MAX_CONCURRENT);
    const settled = await Promise.allSettled(batch.map((c) => connectMcpServer(c)));
    settled.forEach((r, idx) => {
      const cfg = batch[idx];
      if (r.status === "rejected") {
        console.warn(`[mcp] connect failed for "${cfg.name}":`, r.reason);
        return;
      }
      connected.push(r.value);
      for (const mt of [...r.value.tools].sort((a, b) => a.name.localeCompare(b.name))) {
        tools[mcpToolName(cfg.name, mt.name)] = adaptMcpTool(r.value.client, cfg.name, mt);
      }
    });
  }

  return {
    tools,
    close: async () => {
      await Promise.allSettled(connected.map(disconnectMcp));
    },
  };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.
```bash
git add src/lib/mcp/load.ts
git commit -m "feat(mcp): loader — connect enabled servers, merge namespaced tools, skip failures"
```

---

## Task 8: Wire MCP tools into the agent loop

**Files:** Modify `src/lib/tasks/runner.ts`

- [ ] **Step 1: Import the loader**

After the skills imports near the top:
```ts
import { loadMcpTools } from "@/lib/skills/../mcp/load";
```
(or simply `import { loadMcpTools } from "@/lib/mcp/load";`)

- [ ] **Step 2: Load + merge in `prepareRun`**

Replace the tools-composition block:
```ts
  const sandbox = await loadSandboxTools(userId, sessionKey, project?.sandboxNetwork ?? undefined);
  const availableSkills = await listAvailableSkills(userId, payload.projectId ?? null);
  const skillTool = makeSkillTool({ userId, sessionKey, projectId: payload.projectId ?? null });
  const tools = { ...sandbox.tools, skill: skillTool };
```
with:
```ts
  const sandbox = await loadSandboxTools(userId, sessionKey, project?.sandboxNetwork ?? undefined);
  const mcp = await loadMcpTools({ userId, projectId: payload.projectId ?? null });
  const availableSkills = await listAvailableSkills(userId, payload.projectId ?? null);
  const skillTool = makeSkillTool({ userId, sessionKey, projectId: payload.projectId ?? null });
  // Deterministic order keeps the position-0 tools prefix cache-stable.
  const tools = { ...sandbox.tools, ...mcp.tools, skill: skillTool };
```

- [ ] **Step 3: Dispose MCP clients alongside sandbox**

Change the return so the caller closes both. Replace:
```ts
  return { model, provider, modelId, tools, closeMcp: sandbox.close, prompt, userMemories };
```
with:
```ts
  const closeAll = async () => { await Promise.allSettled([sandbox.close(), mcp.close()]); };
  return { model, provider, modelId, tools, closeMcp: closeAll, prompt, userMemories };
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (`runAgentTask` already calls `closeMcp?.()` in `finally`, so both clients are disposed.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/tasks/runner.ts
git commit -m "feat(mcp): load + merge MCP connector tools into the agent loop"
```

---

## Task 9: Integration check — in-memory MCP round-trip

**Files:** Create `src/lib/mcp/__tests__/integration.test.ts`

Uses the SDK's in-memory linked transport so no network is needed.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { adaptMcpTool, mcpToolName } from "../adapt";

describe("MCP round-trip (in-memory)", () => {
  it("lists a tool, adapts it, and executes a call", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    server.tool("echo", "Echo back", { msg: z.string() }, async ({ msg }) => ({
      content: [{ type: "text", text: `echo:${msg}` }],
    }));

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([client.connect(clientT), server.connect(serverT)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("echo");
    expect(mcpToolName("test", "echo")).toBe("mcp__test__echo");

    const adapted = adaptMcpTool(client as never, "test", tools[0] as never);
    const out = (await adapted.execute!({ msg: "hi" }, { toolCallId: "1", messages: [] } as never)) as {
      content: { type: string; text: string }[];
    };
    expect(out.content[0].text).toBe("echo:hi");

    await client.close();
  });
});
```

> If the `McpServer.tool(...)` registration signature differs in the installed SDK version, adjust to the version's documented form (check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts`) — the assertions on adapt/namespacing/execute are what matter.

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/mcp/__tests__/integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mcp/__tests__/integration.test.ts
git commit -m "test(mcp): in-memory connect → list → adapt → call round-trip"
```

---

## Task 10: API — connector CRUD

**Files:**
- Create: `src/app/api/mcp/route.ts` (user)
- Create: `src/app/api/admin/mcp/route.ts` (admin)

- [ ] **Step 1: User route** (`src/app/api/mcp/route.ts`)

```ts
import { apiHandler, requireSession } from "@/lib/auth";
import { listServers, upsertServer, setEnabled, deleteServer } from "@/lib/mcp/service";
import { db } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  return Response.json({ servers: await listServers(userId, null) });
});

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { name, url, headers } = await req.json();
  if (typeof name !== "string" || typeof url !== "string") {
    return Response.json({ error: "name and url required" }, { status: 400 });
  }
  const secrets = headers && typeof headers === "object" ? { headers } : undefined;
  const id = await upsertServer({ scope: "user", userId, projectId: null, name, url, secrets });
  return Response.json({ ok: true, id });
});

export const PATCH = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { id, enabled } = await req.json();
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const owned = await db.select({ id: mcpServers.id }).from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId), eq(mcpServers.scope, "user"))).limit(1);
  if (!owned[0]) return Response.json({ error: "Not found or not yours" }, { status: 404 });
  await setEnabled(id, enabled);
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const owned = await db.select({ id: mcpServers.id }).from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId), eq(mcpServers.scope, "user"))).limit(1);
  if (!owned[0]) return Response.json({ error: "Not found or not yours" }, { status: 404 });
  await deleteServer(id);
  return Response.json({ ok: true });
});
```

- [ ] **Step 2: Admin route** (`src/app/api/admin/mcp/route.ts`)

```ts
import { apiHandler, requireAdmin } from "@/lib/auth";
import { upsertServer, setEnabled, deleteServer } from "@/lib/mcp/service";

export const POST = apiHandler(async (req: Request) => {
  await requireAdmin();
  const { name, url, headers, scope, projectId } = await req.json();
  if (typeof name !== "string" || typeof url !== "string") {
    return Response.json({ error: "name and url required" }, { status: 400 });
  }
  const s = scope === "project" ? "project" : "system";
  const secrets = headers && typeof headers === "object" ? { headers } : undefined;
  const id = await upsertServer({
    scope: s, userId: null, projectId: s === "project" ? (projectId ?? null) : null, name, url, secrets,
  });
  return Response.json({ ok: true, id });
});

export const PATCH = apiHandler(async (req: Request) => {
  await requireAdmin();
  const { id, enabled } = await req.json();
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  await setEnabled(id, enabled);
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async (req: Request) => {
  await requireAdmin();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await deleteServer(id);
  return Response.json({ ok: true });
});
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.
```bash
git add src/app/api/mcp/route.ts src/app/api/admin/mcp/route.ts
git commit -m "feat(mcp): connector CRUD API (user + admin)"
```

---

## Task 11: Connectors settings UI

**Files:**
- Create: `src/app/(dashboard)/settings/connectors/page.tsx`
- Modify: `src/app/(dashboard)/settings/layout.tsx`
- Modify: `messages/en.json`, `messages/uk.json`

- [ ] **Step 1: Nav entry**

In `settings/layout.tsx`, add `Plug` to the lucide import and a nav item after `skills`:
```ts
  { key: "connectors", href: "/settings/connectors", icon: Plug },
```

- [ ] **Step 2: Page** (`settings/connectors/page.tsx`)

A client component modeled on `settings/skills/page.tsx`: fetch `GET /api/mcp`; render each server (name, scope badge, url host, health-agnostic) with an enable Switch (enabled for `user` scope, disabled for `system`/`project`); an "Add connector" form (name, url, optional `Authorization` bearer token → sent as `headers: { Authorization: "Bearer <token>" }`) calling `POST /api/mcp`; a delete button for own user-scope rows calling `DELETE /api/mcp?id=`. Use `Button`, `Input`, `Switch`, `Badge`, `Separator`, `toast`, and `useTranslations("settings.connectors")`. Follow the exact styling/handlers of the skills page (optimistic toggle with rollback).

```tsx
"use client";
import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Plug, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

interface Server { id: string; name: string; url: string | null; scope: "system" | "user" | "project"; enabled: boolean }

export default function ConnectorsPage() {
  const t = useTranslations("settings.connectors");
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp");
      if (res.ok) setServers((await res.json()).servers ?? []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!name.trim() || !url.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { name, url };
      if (token.trim()) body.headers = { Authorization: `Bearer ${token.trim()}` };
      const res = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(t("added")); setName(""); setUrl(""); setToken(""); setShowForm(false); await load(); }
      else toast.error(data.error || t("addFailed"));
    } finally { setSaving(false); }
  };

  const toggle = async (id: string, enabled: boolean) => {
    const prev = servers;
    setServers((s) => s.map((x) => x.id === id ? { ...x, enabled } : x));
    const res = await fetch("/api/mcp", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, enabled }) });
    if (!res.ok) { setServers(prev); toast.error(t("toggleFailed")); }
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/mcp?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) { setServers((s) => s.filter((x) => x.id !== id)); toast.success(t("deleted")); }
    else toast.error(t("deleteFailed"));
  };

  const scopeLabel: Record<Server["scope"], string> = { system: t("scope.system"), user: t("scope.user"), project: t("scope.project") };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <Separator />

      <div className="flex justify-end">
        {!showForm && <Button variant="outline" size="sm" onClick={() => setShowForm(true)}><Plus className="mr-1.5 h-4 w-4" />{t("add")}</Button>}
      </div>

      {showForm && (
        <div className="space-y-3 rounded-md border p-4">
          <Input placeholder={t("namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input placeholder={t("tokenPlaceholder")} value={token} onChange={(e) => setToken(e.target.value)} type="password" />
          <div className="flex gap-2">
            <Button size="sm" onClick={add} disabled={saving}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{t("save")}</Button>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>{t("cancel")}</Button>
          </div>
        </div>
      )}

      {loading && <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
      {!loading && servers.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
          <Plug className="h-5 w-5 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      )}
      {!loading && servers.map((s) => (
        <div key={s.id} className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{s.name}</span>
              <Badge variant="secondary">{scopeLabel[s.scope]}</Badge>
            </div>
            {s.url && <p className="truncate text-xs text-muted-foreground">{s.url}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Switch checked={s.enabled} disabled={s.scope !== "user"} onCheckedChange={(v) => toggle(s.id, v)} aria-label={t("toggleAria", { name: s.name })} />
            {s.scope === "user" && (
              <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive" onClick={() => remove(s.id)} aria-label={t("delete")}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: i18n keys** — add `settings.nav.connectors` and the `settings.connectors.*` block (`title, subtitle, add, save, cancel, namePlaceholder, tokenPlaceholder, added, addFailed, toggleFailed, deleted, deleteFailed, empty, toggleAria, delete, scope.{system,user,project}`) to BOTH `messages/en.json` and `messages/uk.json` (uk: formal «Ви»). Reuse common keys where they exist.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/settings/connectors/page.tsx" "src/app/(dashboard)/settings/layout.tsx" messages/en.json messages/uk.json
git commit -m "feat(mcp): connectors settings UI (add/list/toggle/delete) + i18n"
```

---

## Task 12: End-to-end verification

**Files:** none

- [ ] **Step 1: Restart the platform container** (HMR doesn't reload the worker)

Run: `npm run docker:down && npm run docker:dev`

- [ ] **Step 2: Add a connector** at `/settings/connectors` pointing at a known public MCP server (e.g. a test Streamable HTTP endpoint) with a bearer token; confirm it lists.

- [ ] **Step 3: Drive the agent** with a request that needs that connector; confirm in the run that a `mcp__<server>__<tool>` tool-call appears and returns a result.

- [ ] **Step 4: Full suite green**

Run: `npx vitest run`
Expected: all MCP + pre-existing tests pass.

---

## Self-Review (completed during planning)

- **Spec coverage:** `@modelcontextprotocol/sdk` + `dynamicTool` (T0/T3/T6), namespacing `mcp__server__tool` (T3), `mcp_servers` table + scope model (T4), scope precedence + encrypted secrets + SSRF (T5, reusing T1), loader skips dead servers + deterministic order (T7), runner merge + dispose + cache-stable order (T8), in-memory round-trip test (T9), CRUD API user/admin with scope-gating (T10), connectors UI + i18n (T11), e2e (T12). Forward-compat seams (`secrets.env`, `transport` stdio/sse stored-not-served, `source` catalog, SecretDescriptor) present in T2/T4/T5.
- **Cuts honored:** `sse`/`stdio` rejected by service (B1=http only); OAuth deferred (static bearer); resources/prompts/UI-widgets out; catalog install is C/D; per-tool permission policy is the future governance layer.
- **Type consistency:** `McpServerConfig`/`McpServerInfo`/`McpSecrets` (T2) used unchanged in T5/T6/T7; `connectMcpServer`→`ConnectedMcp` (T6) consumed by T7; `adaptMcpTool(client, server, tool)`/`mcpToolName(server, tool)` (T3) used in T7/T9; service fns (`listEnabledServerConfigs`, `listServers`, `upsertServer`, `setEnabled`, `deleteServer`) consistent across T5/T10.
- **Reuse:** SSRF guard extracted once (T1) and shared by providers + MCP; crypto + master key reused; settings-page + API patterns mirrored from skills.
