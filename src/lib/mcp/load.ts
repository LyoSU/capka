import type { Tool } from "ai";
import { getBlockPrivateProviderUrls } from "@/lib/settings";
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
  // Same SSRF policy the connector URL was validated against at upsert time.
  const blockPrivate = await getBlockPrivateProviderUrls();
  const connected: ConnectedMcp[] = [];
  const tools: Record<string, Tool> = {};

  for (let i = 0; i < configs.length; i += MAX_CONCURRENT) {
    const batch = configs.slice(i, i + MAX_CONCURRENT);
    const settled = await Promise.allSettled(batch.map((c) => connectMcpServer(c, { blockPrivate })));
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
