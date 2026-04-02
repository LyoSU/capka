/**
 * HTTP client for the sandbox-controller service.
 * Platform never touches Docker socket directly — only through this API.
 */

import { SandboxError } from "@/lib/errors";

const CONTROLLER_URL = process.env.SANDBOX_CONTROLLER_URL || "http://localhost:3001";
const CONTROLLER_SECRET = process.env.CONTROLLER_SECRET || "unclaw-sandbox-secret";

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${CONTROLLER_SECRET}` };
}

async function request(path: string, method: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(`${CONTROLLER_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === "POST" ? 150_000 : 10_000),
    });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.cause && typeof (err as NodeJS.ErrnoException).cause === "object"
      ? ((err as NodeJS.ErrnoException).cause as NodeJS.ErrnoException).code
      : undefined;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
      console.error(`[sandbox] ${method} ${path}: controller unreachable (${code})`);
      throw new SandboxError(
        "Code execution is temporarily unavailable. Please try again in a moment.",
        "connect",
        true,
      );
    }
    throw err;
  }

  const data = await res.json().catch(() => ({ error: `Sandbox ${res.status}` }));
  if (!res.ok) {
    const op = path.split("/").pop() || method.toLowerCase();
    const raw = data.error || `Sandbox ${res.status}`;
    console.error(`[sandbox] ${method} ${path}:`, raw);
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

// ── File operations (native controller endpoints) ────────────

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
};

export async function listFiles(sessionId: string, path = "."): Promise<{ entries: FileEntry[]; error?: string }> {
  const id = sanitizeId(sessionId);
  const params = new URLSearchParams({ path });
  return request(`/sessions/${id}/files?${params}`, "GET");
}

export async function downloadFile(sessionId: string, filePath: string): Promise<Response> {
  const id = sanitizeId(sessionId);
  const params = new URLSearchParams({ path: filePath });
  const res = await fetch(`${CONTROLLER_URL}/sessions/${id}/download?${params}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Download failed" }));
    console.error("[sandbox] download:", err.error);
    throw new SandboxError("File download failed", "download", res.status >= 500);
  }
  return res;
}

export async function uploadFile(sessionId: string, path: string, file: File): Promise<{ ok: boolean; path: string; name: string }> {
  const id = sanitizeId(sessionId);
  const form = new FormData();
  form.append("path", path);
  form.append("file", file);

  const res = await fetch(`${CONTROLLER_URL}/sessions/${id}/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("[sandbox] upload:", data.error);
    throw new SandboxError("File upload failed", "upload", false);
  }
  return data;
}
