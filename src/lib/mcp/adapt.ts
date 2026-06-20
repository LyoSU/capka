import { dynamicTool, jsonSchema } from "ai";

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
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal },
  ): Promise<McpCallResult>;
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
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
  const parts = blocks.map((b) => {
    if (b.type === "text" && typeof b.text === "string") return { type: "text" as const, text: b.text };
    if ((b.type === "image" || b.type === "audio") && b.data && b.mimeType) {
      return { type: "media" as const, data: b.data, mediaType: b.mimeType };
    }
    if (b.type === "resource" && b.resource) {
      if (typeof b.resource.text === "string") return { type: "text" as const, text: b.resource.text };
      if (b.resource.blob && b.resource.mimeType) {
        return { type: "media" as const, data: b.resource.blob, mediaType: b.resource.mimeType };
      }
    }
    return { type: "text" as const, text: JSON.stringify(b) };
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
    inputSchema: jsonSchema((mcpTool.inputSchema ?? { type: "object", properties: {} }) as never),
    execute: async (input, { abortSignal }) => {
      const result = await client.callTool(
        { name: mcpTool.name, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        { signal: abortSignal },
      );
      if (result.isError) throw new Error(textOf(result) || `${serverName} ${mcpTool.name} failed`);
      return result;
    },
    toModelOutput: ({ output }) => ({ type: "content", value: toModelContent(output as McpCallResult) }),
  });
}
