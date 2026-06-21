/**
 * Last connect error per MCP server, kept in-process so the connectors UI can show
 * *why* a server didn't load — especially stdio servers, which can't be probed
 * outside a run (the health probe skips them). The worker records here when a
 * connect fails at run time; the health endpoint (same process) reads it.
 */
const errors = new Map<string, { detail: string; at: number }>();
const TTL_MS = 10 * 60_000;

export function recordConnectError(id: string | undefined, detail: string): void {
  if (!id) return;
  errors.set(id, { detail: detail.slice(0, 400), at: Date.now() });
}

export function clearConnectError(id: string | undefined): void {
  if (id) errors.delete(id);
}

export function getConnectError(id: string): string | null {
  const e = errors.get(id);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { errors.delete(id); return null; }
  return e.detail;
}
