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
