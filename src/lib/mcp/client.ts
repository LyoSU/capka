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
