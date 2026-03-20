import { MCPClient } from "@mastra/mcp";

/**
 * Creates an MCP client with a filesystem server scoped to the user's storage path.
 */
export function createMCPClient(storagePath: string) {
  return new MCPClient({
    id: `mcp-${storagePath}`,
    servers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", storagePath],
      },
    },
    timeout: 30_000,
  });
}

/**
 * Load MCP tools for a user. Returns tools and a disconnect function.
 */
export async function loadMCPTools(userId: string) {
  const client = createMCPClient(`./data/storage/${userId}`);
  let tools;
  try {
    tools = await client.listTools();
  } catch {
    tools = {};
  }
  return {
    tools,
    disconnect: () => client.disconnect().catch(() => {}),
  };
}
