/** Every tool Capka itself registers on a turn (prepareRun in run-context.ts), by
 *  name. Connector tools are not listed: they are all `mcp__<server>__<tool>`.
 *
 *  A plain list in a dependency-free module because display code (message.tsx,
 *  the reasoning cleaner) needs the names too and cannot import the factories
 *  without pulling server code into the client bundle. The registry checks itself
 *  against this list — native-tools.test.ts builds every factory and fails on a
 *  name missing here — so the two cannot drift silently. */
export const NATIVE_TOOL_NAMES = [
  // sandbox (loadSandboxTools)
  "execute_bash", "execute_python", "execute_node", "check_job",
  "read_file", "write_file", "str_replace", "list_files", "search_files", "delete_path",
  "view_file", "update_plan", "skill", "manage", "ask", "nothing_to_report",
  // memory (makeVaultMemoryTools)
  "memory_search", "memory_fact_write", "memory_note_write", "memory_open", "memory_file", "memory_link", "memory_forget",
  // provider-executed (providerNativeTools) and progressive disclosure (planToolSearch)
  "google_search", "find_tool",
] as const;

const NATIVE = new Set<string>(NATIVE_TOOL_NAMES);

export const isKnownToolName = (name: string) => NATIVE.has(name) || name.startsWith("mcp__");
