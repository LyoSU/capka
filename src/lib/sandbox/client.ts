/**
 * HTTP client for the sandbox-controller service.
 * Platform never touches Docker socket directly — only through this API.
 */

import { createHmac } from "node:crypto";
import { SandboxError } from "@/lib/errors";
import { log } from "@/lib/log";

const CONTROLLER_URL = process.env.SANDBOX_CONTROLLER_URL || "http://localhost:3001";
const CONTROLLER_SECRET = process.env.CONTROLLER_SECRET ?? "";

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${CONTROLLER_SECRET}` };
}

/** HMAC proving this caller is authorized to act on <userId>'s workspace.
 *  The controller recomputes it from the same shared secret. Must match the
 *  controller's `workspaceToken` exactly (sanitized userId|sessionId). */
function workspaceToken(userId: string, sessionId: string): string {
  return createHmac("sha256", CONTROLLER_SECRET)
    .update(`${sanitizeId(userId)}|${sanitizeId(sessionId)}`)
    .digest("hex");
}

/** Wrap fetch — rethrow ECONNREFUSED/ENOTFOUND as user-friendly SandboxError */
async function sandboxFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err: unknown) {
    const cause = (err as NodeJS.ErrnoException)?.cause;
    const code = cause && typeof cause === "object" ? (cause as NodeJS.ErrnoException).code : undefined;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
      log.error("sandbox controller unreachable", { code });
      throw new SandboxError(
        "Code execution is temporarily unavailable. Please try again in a moment.",
        "connect",
        true,
      );
    }
    throw err;
  }
}

async function request(path: string, method: string, body?: unknown) {
  const res = await sandboxFetch(`${CONTROLLER_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(method === "POST" ? 150_000 : 10_000),
  });

  const data = await res.json().catch(() => ({ error: `Sandbox ${res.status}` }));
  if (!res.ok) {
    const op = path.split("/").pop() || method.toLowerCase();
    const raw = data.error || `Sandbox ${res.status}`;
    log.error("sandbox request failed", { method, path, status: res.status, err: String(raw) });
    // The workspace-full block is an actionable condition the agent must SEE and
    // act on (free space, then retry), so its message passes through verbatim.
    // Everything else collapses to a generic message — we don't leak controller
    // internals to end users for failures they can't act on.
    if (data.code === "WORKSPACE_FULL") {
      throw new SandboxError(String(raw), op, false, 413);
    }
    throw new SandboxError("Sandbox operation failed", op, res.status >= 500);
  }
  return data;
}

// ── Session lifecycle ────────────────────────────────────────

export async function createSession(sessionId: string, userId: string, networkMode?: string) {
  return request("/sessions", "POST", {
    sessionId: sanitizeId(sessionId),
    userId: sanitizeId(userId),
    ...(networkMode ? { networkMode } : {}),
  });
}

export async function execCommand(sessionId: string, command: string, timeout?: number) {
  return request(`/sessions/${sanitizeId(sessionId)}/exec`, "POST", { command, timeout }) as Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

export async function destroySession(sessionId: string) {
  return request(`/sessions/${sanitizeId(sessionId)}`, "DELETE");
}

// ── stdio MCP bridge (server runs inside the sandbox, controller relays frames) ─

const mcpName = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

/** Launch a stdio MCP server inside the session sandbox. Idempotent per name. */
export async function mcpStart(
  sessionId: string,
  name: string,
  spec: { command: string; args?: string[]; env?: Record<string, string> },
): Promise<void> {
  await request(`/sessions/${sanitizeId(sessionId)}/mcp/${mcpName(name)}/start`, "POST", spec);
}

/** One JSON-RPC round-trip to a started stdio MCP server. Returns the response
 *  message, or null for a notification (no id). */
export async function mcpRpc(sessionId: string, name: string, message: unknown): Promise<unknown> {
  const data = (await request(`/sessions/${sanitizeId(sessionId)}/mcp/${mcpName(name)}/rpc`, "POST", { message })) as {
    message: unknown;
  };
  return data.message ?? null;
}

// ── File operations (native controller endpoints) ────────────

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
};

export async function listFiles(sessionId: string, path = ".", userId?: string, depth?: number): Promise<{ entries: FileEntry[]; error?: string }> {
  const id = sanitizeId(sessionId);
  const params = new URLSearchParams({ path });
  if (depth && depth > 1) params.set("depth", String(depth));
  if (userId) {
    params.set("userId", userId);
    params.set("token", workspaceToken(userId, sessionId));
  }
  return request(`/sessions/${id}/files?${params}`, "GET");
}

export async function downloadFile(sessionId: string, filePath: string, userId?: string): Promise<Response> {
  const id = sanitizeId(sessionId);
  const params = new URLSearchParams({ path: filePath });
  if (userId) {
    params.set("userId", userId);
    params.set("token", workspaceToken(userId, sessionId));
  }
  const res = await sandboxFetch(`${CONTROLLER_URL}/sessions/${id}/download?${params}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Download failed" }));
    log.error("sandbox download failed", { err: String(err.error) });
    // Pass a client condition (e.g. 404 missing file) through unchanged; collapse a
    // real upstream failure (5xx) into 502 so it reads as a gateway error, not the
    // controller's raw internal status.
    const status = res.status >= 500 ? 502 : res.status;
    throw new SandboxError("File download failed", "download", res.status >= 500, status);
  }
  return res;
}

export async function deleteFile(sessionId: string, filePath: string, userId?: string): Promise<{ ok: boolean }> {
  const id = sanitizeId(sessionId);
  const params = new URLSearchParams({ path: filePath });
  if (userId) {
    params.set("userId", userId);
    params.set("token", workspaceToken(userId, sessionId));
  }
  return request(`/sessions/${id}/files?${params}`, "DELETE");
}

export async function uploadFile(sessionId: string, path: string, file: File, userId?: string): Promise<{ ok: boolean; path: string; name: string }> {
  const id = sanitizeId(sessionId);
  const form = new FormData();
  form.append("path", path);
  form.append("file", file);

  const query = userId
    ? `?userId=${encodeURIComponent(sanitizeId(userId))}&token=${workspaceToken(userId, sessionId)}`
    : "";
  const res = await sandboxFetch(`${CONTROLLER_URL}/sessions/${id}/upload${query}`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (!res.ok) {
    log.error("sandbox upload failed", { err: String(data.error) });
    throw new SandboxError("File upload failed", "upload", false);
  }
  return data;
}
