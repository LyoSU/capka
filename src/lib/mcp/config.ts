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
