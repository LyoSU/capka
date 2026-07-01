import { dynamicTool, jsonSchema } from "ai";
import { clampOutput, MAX_TOOL_OUTPUT_CHARS } from "@/lib/tool-output";
import { spillToWorkspace } from "./spill";

/** Ceiling for a single MCP media/blob block, measured on the base64 STRING
 *  length — that is what lands in Postgres and re-enters the model context every
 *  turn, so it is the figure that actually costs. Over it, the blob is parked in
 *  the workspace and replaced by a text pointer (see spillMedia). */
const MAX_MCP_MEDIA_BYTES = Number(process.env.MAX_MCP_MEDIA_BYTES) || 5 * 1024 * 1024;
/** Cap on an MCP tool's DESCRIPTION. Untrusted servers ship enormous descriptions
 *  that tax the context of EVERY call before any tool even runs (the "menu tax"). */
const MAX_MCP_TOOL_DESC_CHARS = Number(process.env.MAX_MCP_TOOL_DESC_CHARS) || 1024;

/** Where spill writes and who owns the workspace — threaded from loadMcpTools.
 *  Absent (e.g. no sandbox session) means spill degrades to a plain clamp. */
interface SpillCtx {
  sessionKey?: string;
  userId?: string;
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

/** Minimal shape we need from an MCP client + tool (avoids SDK type coupling). */
interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
/** The slice of an MCP CallToolResult we consume. `content` is the tool's output
 *  blocks; `isError` flags a tool-level failure (the SDK does NOT throw on it). */
interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { text?: string; blob?: string; mimeType?: string };
  [k: string]: unknown;
}
interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}
interface McpCaller {
  // Return is `unknown` (not McpCallResult): the SDK's callTool resolves to a wider
  // compatibility union (incl. a legacy `{ toolResult }` shape), so narrowing here
  // would make the real Client unassignable. We cast at the call site instead.
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/**
 * Prune a JSON Schema so every entry in a `required` array is actually declared
 * in the sibling `properties`. MCP servers are external and routinely ship
 * schemas where `required` lists a property they forgot to declare; permissive
 * gateways (OpenAI-style) ignore it, but Google AI Studio rejects the WHOLE
 * request ("GenerateContentRequest.tools[…].parameters.required[N]: property is
 * not defined"), which silently blocks every Google model for a user with many
 * tools. This is schema hygiene at the single trust boundary where untrusted
 * tool schemas enter the model call — not a per-provider workaround. Recurses
 * into nested object properties, array `items`, and anyOf/oneOf/allOf branches.
 * Returns a new value; never mutates the caller's schema.
 */
export function sanitizeToolSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(sanitizeToolSchema) as T;
  if (schema === null || typeof schema !== "object") return schema;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = sanitizeToolSchema(v);

  const props = out.properties;
  if (Array.isArray(out.required) && props !== null && typeof props === "object") {
    const declared = new Set(Object.keys(props as Record<string, unknown>));
    const pruned = (out.required as unknown[]).filter((r) => typeof r === "string" && declared.has(r));
    if (pruned.length) out.required = pruned;
    else delete out.required;
  }
  return out as T;
}

/** Concatenate an MCP result's text blocks — used for an error message. */
function textOf(result: McpCallResult): string {
  return (result.content ?? [])
    .map((b) => b.text ?? b.resource?.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

// ── Bounding (async, runs in execute) ────────────────────────────────────────
// A connector is untrusted and can return an arbitrarily large text blob or a
// multi-megabyte base64 image. Left alone it floods the model context AND is
// persisted to Postgres + re-sent every turn (real $). We bound the result HERE,
// in execute, because (a) spilling to a file is async and toModelOutput is not,
// and (b) execute's return is what gets persisted and REPLAYED next turn — so
// bounding it once fixes the live view, the DB row, and every future turn.

/** Park oversized text; return a clamped view whose recovery note points at the
 *  parked file (or a plain clamp when there's nowhere to park it). */
async function spillText(text: string, ctx: SpillCtx): Promise<string> {
  const path = await spillToWorkspace(ctx.sessionKey, ctx.userId, {
    bytes: Buffer.from(text, "utf8"),
    mimeType: "text/plain",
  });
  const note = path
    ? `Full result (~${kb(text.length)}) saved at ${path} — read or grep it (read_file/execute_bash) instead of re-running.`
    : undefined;
  return clampOutput(text, { note }).text;
}

/** Park an oversized media/blob and replace it with a text pointer. Media can't be
 *  truncated (a half JPEG is garbage), so over the ceiling the model no longer
 *  SEES it — but it can still process the parked file programmatically. */
async function spillMedia(b64: string, mimeType: string | undefined, ctx: SpillCtx): Promise<McpContentBlock> {
  // Buffer.from(_, "base64") is lenient: a wholly invalid string decodes to 0
  // bytes. Treat that as "nothing worth parking" and fall through to the note.
  const bytes = Buffer.from(b64, "base64");
  const path = bytes.length ? await spillToWorkspace(ctx.sessionKey, ctx.userId, { bytes, mimeType }) : null;
  const mt = mimeType || "binary";
  const size = kb(bytes.length || Math.floor((b64.length * 3) / 4));
  const text = path
    ? `[Capka: ${mt} result (~${size}) too large to view inline — saved at ${path}. Process it programmatically (execute_python/execute_bash: OCR, ffprobe, convert, …).]`
    : `[Capka: ${mt} result (~${size}) too large to inline and could not be saved — omitted. Re-run requesting a smaller result or a specific field.]`;
  return { type: "text", text };
}

async function boundBlock(b: McpContentBlock, ctx: SpillCtx): Promise<McpContentBlock> {
  if (b.type === "text" && typeof b.text === "string" && b.text.length > MAX_TOOL_OUTPUT_CHARS) {
    return { ...b, text: await spillText(b.text, ctx) };
  }
  if ((b.type === "image" || b.type === "audio") && typeof b.data === "string" && b.data.length > MAX_MCP_MEDIA_BYTES) {
    return spillMedia(b.data, b.mimeType, ctx);
  }
  if (b.type === "resource" && b.resource) {
    if (typeof b.resource.text === "string" && b.resource.text.length > MAX_TOOL_OUTPUT_CHARS) {
      return { ...b, resource: { ...b.resource, text: await spillText(b.resource.text, ctx) } };
    }
    if (typeof b.resource.blob === "string" && b.resource.blob.length > MAX_MCP_MEDIA_BYTES) {
      return spillMedia(b.resource.blob, b.resource.mimeType, ctx);
    }
  }
  return b;
}

/** Bound every content block of a result before it is persisted/returned. */
async function boundResult(result: McpCallResult, ctx: SpillCtx): Promise<McpCallResult> {
  if (!result.content?.length) return result;
  return { ...result, content: await Promise.all(result.content.map((b) => boundBlock(b, ctx))) };
}

/** Truncate a runaway tool description (the per-call "menu tax"). */
function clampDescription(d: string): string {
  return d.length > MAX_MCP_TOOL_DESC_CHARS ? `${d.slice(0, MAX_MCP_TOOL_DESC_CHARS)} …` : d;
}

/** Map MCP content blocks to AI SDK tool-output parts so the model receives clean
 *  text + inline media instead of a JSON envelope. Unknown blocks degrade to text.
 *  Blocks are already size-bounded by boundResult (in execute); the clampOutput
 *  here is a harmless safety net. */
function toModelContent(result: McpCallResult) {
  const blocks = result.content ?? [];
  // A chatty connector (a scraper, a DB query over thousands of rows) can return
  // arbitrarily large text — unbounded, it floods the model's context and is
  // persisted+re-sent every turn, exactly like an unclamped shell command. Route
  // text through the same per-result clamp the sandbox tools use. Media blocks
  // pass through untouched (the model needs the bytes whole).
  const text = (s: string) => ({ type: "text" as const, text: clampOutput(s).text });
  const parts = blocks.map((b) => {
    if (b.type === "text" && typeof b.text === "string") return text(b.text);
    if ((b.type === "image" || b.type === "audio") && b.data && b.mimeType) {
      return { type: "media" as const, data: b.data, mediaType: b.mimeType };
    }
    if (b.type === "resource" && b.resource) {
      if (typeof b.resource.text === "string") return text(b.resource.text);
      if (b.resource.blob && b.resource.mimeType) {
        return { type: "media" as const, data: b.resource.blob, mediaType: b.resource.mimeType };
      }
    }
    return text(JSON.stringify(b));
  });
  return parts.length ? parts : [{ type: "text" as const, text: "" }];
}

/** Wrap one MCP tool as an AI SDK dynamic tool (schema known at runtime).
 *  - the run's abort signal is forwarded, so cancel/deadline stops an in-flight call;
 *  - a tool-level `isError` result is thrown (the SDK doesn't), so it surfaces as a
 *    real tool error rather than masquerading as a successful result;
 *  - `toModelOutput` hands the model proper text/media parts. */
export function adaptMcpTool(client: McpCaller, serverName: string, mcpTool: McpToolDef, ctx: SpillCtx = {}) {
  return dynamicTool({
    description: clampDescription(mcpTool.description ?? `${serverName} ${mcpTool.name}`),
    inputSchema: jsonSchema(sanitizeToolSchema(mcpTool.inputSchema ?? { type: "object", properties: {} }) as never),
    execute: async (input, { abortSignal }) => {
      const result = (await client.callTool(
        { name: mcpTool.name, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        { signal: abortSignal },
      )) as McpCallResult;
      if (result.isError) throw new Error(textOf(result) || `${serverName} ${mcpTool.name} failed`);
      return boundResult(result, ctx);
    },
    toModelOutput: ({ output }) => ({ type: "content", value: toModelContent(output as McpCallResult) }),
  });
}
