/**
 * HTTP client for the sandbox-controller service.
 * Platform never touches Docker socket directly — only through this API.
 */

import { createHmac } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import { SandboxError } from "@/lib/errors";
import { log } from "@/lib/log";
import { withChildSpan, sanitizeRoute } from "@/lib/telemetry";

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

/** Which level a controller failure deserves, from its status alone.
 *
 *  A 4xx is a condition the CALLER has to handle — a file that isn't there, a full
 *  workspace, a session that has gone — not a fault of the deployment. Reporting
 *  those as errors is what made a workspace path the agent merely mentioned look
 *  like a broken download path. A 5xx is the deployment's problem and stays an
 *  error. Every failure site in this file uses this, so no one site's level reads
 *  as a deliberate exception to the others. */
function failureLevel(status: number): "warn" | "error" {
  return status >= 500 ? "error" : "warn";
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

/**
 * Every JSON controller call goes through here, so one span covers exec, session
 * create, file listing, and the MCP bridge — and shows a cold container start as
 * a slow `/sessions` sibling before the `/sessions/{id}/exec` that follows it.
 *
 * The raw `path` is NEVER recorded: it carries session keys, filenames,
 * user-chosen MCP server names, and on DELETE a `workspaceToken` in the query
 * string. `sanitizeRoute` reduces it to a template with the query dropped.
 */
async function request(path: string, method: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal) {
  return withChildSpan(
    "capka.sandbox.request",
    { "capka.sandbox.route": sanitizeRoute(path), "capka.sandbox.method": method },
    (span) => sendRequest(path, method, body, timeoutMs, span, signal),
  );
}

async function sendRequest(path: string, method: string, body: unknown, timeoutMs: number | undefined, span: Span, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs ?? (method === "POST" ? 150_000 : 10_000));
  const res = await sandboxFetch(`${CONTROLLER_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
    // `signal` is the CALLER's cancellation (a turn the user stopped), unioned with
    // our own timeout. Aborting the request is not just a local give-up: the
    // controller treats the closed connection as "kill the command", so this is the
    // wire that carries a cancel all the way into the container.
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });

  span.setAttribute("capka.sandbox.status", res.status);

  const data = await res.json().catch(() => ({ error: `Sandbox ${res.status}` }));
  if (!res.ok) {
    const op = path.split("/").pop() || method.toLowerCase();
    const raw = data.error || `Sandbox ${res.status}`;
    // The controller's `code` values are a closed set (WORKSPACE_FULL,
    // IMAGE_PULLING, …), so they are safe to record; `raw` is not.
    if (typeof data.code === "string") span.setAttribute("capka.sandbox.error_code", data.code);
    // `sanitizeRoute`, not `path` — the promise three doc-lines up was being broken
    // right here: the raw string carries the query, and on DELETE that query holds a
    // live `workspaceToken`. Any failed listing or delete wrote a valid
    // workspace-access HMAC into the platform log, where it outlives the request.
    log[failureLevel(res.status)]("sandbox request failed", { method, path: sanitizeRoute(path), status: res.status, err: String(raw) });
    // The workspace-full block is an actionable condition the agent must SEE and
    // act on (free space, then retry), so its message passes through verbatim.
    // Everything else collapses to a generic message — we don't leak controller
    // internals to end users for failures they can't act on.
    if (data.code === "WORKSPACE_FULL") {
      throw new SandboxError(String(raw), op, false, 413);
    }
    // First-use on a fresh box: the sandbox image is still downloading. Surface
    // the controller's plain-language "still preparing" message (retryable) so
    // the agent tells the user to wait, not the misleading "can't reach the AI".
    if (data.code === "IMAGE_PULLING") {
      throw new SandboxError(String(raw), op, true, 503);
    }
    throw new SandboxError("Sandbox operation failed", op, res.status >= 500);
  }
  return data;
}

// ── Deployment capabilities ──────────────────────────────────

/** Deployment-level egress kill-switch, read from the controller (the single
 *  source of truth — SANDBOX_ALLOW_NETWORK lives on the controller, not here).
 *  Returns null when the controller is unreachable: callers must treat that as
 *  "unknown", not as "blocked", so a transient outage never mislabels the UI. */
export async function getSandboxAllowNetwork(): Promise<boolean | null> {
  try {
    const res = await sandboxFetch(`${CONTROLLER_URL}/health`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    const data = await res.json().catch(() => null);
    return typeof data?.allowNetwork === "boolean" ? data.allowNetwork : null;
  } catch {
    return null;
  }
}

// ── Session lifecycle ────────────────────────────────────────

/** A host folder to bind-mount into the sandbox at /folders/<name>. Validated by
 *  the controller's mount-safety before it ever reaches Docker. */
export type SandboxMount = { hostPath: string; name: string; ro: boolean };

export async function createSession(sessionId: string, userId: string, networkMode?: string, mounts?: SandboxMount[]) {
  return request("/sessions", "POST", {
    sessionId: sanitizeId(sessionId),
    userId: sanitizeId(userId),
    ...(networkMode ? { networkMode } : {}),
    ...(mounts && mounts.length ? { mounts } : {}),
  });
}

/** Dry-run a host folder path against the controller's mount-safety (single
 *  source of truth for DATA_ROOT + SANDBOX_MOUNT_ALLOW), so the manage/settings
 *  UI can reject a bad path before creating a folder row. */
export async function validateMount(hostPath: string) {
  return request("/mounts/validate", "POST", { hostPath }) as Promise<{ ok: boolean; code?: string }>;
}

/** Lease the session so the controller's idle reaper doesn't reclaim the container
 *  while a detached job is still running. Renewable — the controller caps the total
 *  window on its side, so callers just re-take it while the job lives. */
export async function markBusy(sessionId: string, ms?: number) {
  return request(`/sessions/${sanitizeId(sessionId)}/busy`, "POST", ms === undefined ? {} : { ms }) as Promise<{
    busyUntil: number;
  }>;
}

export async function execCommand(sessionId: string, command: string, timeout?: number, signal?: AbortSignal) {
  // The client abort must OUTLIVE the controller's own exec cap, or a long exec is
  // killed here (fetch abort) before the controller returns its result. The controller
  // clamps exec to ≤300s, so budget that ceiling + a 15s buffer regardless of what the
  // caller asked for (an unset timeout falls back to the controller's env default, which
  // is itself ≤300s). Previously the fixed 150s POST abort silently truncated any exec >150s.
  const clientTimeout = Math.min(timeout ?? 300_000, 300_000) + 15_000;
  // `signal` is the turn's: a cancelled turn must not leave a command running in
  // the sandbox for the rest of that budget (see the abort note in sendRequest).
  return request(`/sessions/${sanitizeId(sessionId)}/exec`, "POST", { command, timeout }, clientTimeout, signal) as Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    /** True when the controller hit its in-memory output ceiling and discarded
     *  the overflow at the source — the rest cannot be retrieved by reading more. */
    truncated?: boolean;
  }>;
}

export async function destroySession(sessionId: string, userId: string) {
  const params = new URLSearchParams({ userId, token: workspaceToken(userId, sessionId) });
  return request(`/sessions/${sanitizeId(sessionId)}?${params}`, "DELETE");
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

export async function listFiles(sessionId: string, path = ".", userId?: string, depth?: number, limit?: number): Promise<{ entries: FileEntry[]; truncated?: boolean; error?: string }> {
  const id = sanitizeId(sessionId);
  const params = new URLSearchParams({ path });
  if (depth && depth > 1) params.set("depth", String(depth));
  if (limit && limit > 1) params.set("limit", String(limit));
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
    // A 404 here is an ordinary outcome, not a fault. `collectReferencedFiles` asks
    // for every /workspace/… path the model MENTIONED, and a mention is not a file:
    // it can be a directory, a path the agent invented, or one it deleted in the
    // same turn — its own caller calls that "skip it quietly". Reporting it as an
    // error, with no session, no path and no status, produced an operator-facing
    // "sandbox download failed" that named nothing and could not be told apart from
    // a broken download path. The status picks the level; the context makes either
    // one actionable.
    log[failureLevel(res.status)]("sandbox download failed", {
      sessionId: id,
      path: filePath,
      status: res.status,
      err: String(err.error),
    });
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

/** Stream the whole workspace as a gzipped tar from the controller (owner-gated).
 *  Complete regardless of any listing limit — the honest "download everything"
 *  backup, used by the hub's "download all" and the delete-project flow. */
export async function archiveWorkspace(sessionId: string, userId: string): Promise<Response> {
  const id = sanitizeId(sessionId);
  const params = new URLSearchParams({ userId: sanitizeId(userId), token: workspaceToken(userId, sessionId) });
  const res = await sandboxFetch(`${CONTROLLER_URL}/sessions/${id}/archive?${params}`, {
    headers: authHeaders(),
    // A big workspace takes a while to tar+gzip; give it room but still bound it.
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    log[failureLevel(res.status)]("sandbox archive failed", { sessionId: id, status: res.status });
    const status = res.status >= 500 ? 502 : res.status;
    throw new SandboxError("Archive failed", "archive", res.status >= 500, status);
  }
  return res;
}

/** Copy another workspace of the same user into this one under `subdir` (the
 *  chat→project carry-over on a move). Idempotent by destination; quota-gated on
 *  the target (a WORKSPACE_FULL SandboxError, status 413, surfaces if it won't fit). */
export async function copyWorkspace(destSessionId: string, srcSessionId: string, subdir: string, userId: string): Promise<void> {
  const dest = sanitizeId(destSessionId);
  const params = new URLSearchParams({ userId: sanitizeId(userId), token: workspaceToken(userId, destSessionId) });
  await request(`/sessions/${dest}/copy-from?${params}`, "POST", {
    srcSessionId: sanitizeId(srcSessionId),
    srcToken: workspaceToken(userId, srcSessionId),
    subdir,
  });
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
    log[failureLevel(res.status)]("sandbox upload failed", { sessionId: id, status: res.status, err: String(data.error) });
    throw new SandboxError("File upload failed", "upload", false);
  }
  return data;
}
