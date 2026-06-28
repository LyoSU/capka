import { dynamicTool, jsonSchema } from "ai";
import { clampOutput } from "@/lib/tool-output";

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

/** Map MCP content blocks to AI SDK tool-output parts so the model receives clean
 *  text + inline media instead of a JSON envelope. Unknown blocks degrade to text. */
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
export function adaptMcpTool(client: McpCaller, serverName: string, mcpTool: McpToolDef) {
  return dynamicTool({
    description: mcpTool.description ?? `${serverName} ${mcpTool.name}`,
    inputSchema: jsonSchema(sanitizeToolSchema(mcpTool.inputSchema ?? { type: "object", properties: {} }) as never),
    execute: async (input, { abortSignal }) => {
      const result = (await client.callTool(
        { name: mcpTool.name, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        { signal: abortSignal },
      )) as McpCallResult;
      if (result.isError) throw new Error(textOf(result) || `${serverName} ${mcpTool.name} failed`);
      return result;
    },
    toModelOutput: ({ output }) => ({ type: "content", value: toModelContent(output as McpCallResult) }),
  });
}
