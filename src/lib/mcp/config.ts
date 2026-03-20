import { mkdirSync } from "fs";
import { resolve } from "path";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Load MCP tools for a user, compatible with AI SDK streamText.
 * Returns tools and a close function.
 */
export async function loadMCPTools(userId: string) {
  const absPath = resolve(`./data/storage/${userId}`);
  mkdirSync(absPath, { recursive: true });

  const client = await createMCPClient({
    transport: new StdioClientTransport({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", absPath],
      stderr: "ignore",
    }),
  });

  let tools;
  try {
    tools = await client.tools();
  } catch {
    tools = {};
  }

  return {
    tools,
    close: () => client.close().catch(() => {}),
  };
}
