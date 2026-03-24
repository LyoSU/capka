/**
 * HTTP client for the sandbox-controller service.
 * Platform never touches Docker socket directly — only through this API.
 */

const CONTROLLER_URL = process.env.SANDBOX_CONTROLLER_URL || "http://sandbox-controller:3001";
const CONTROLLER_SECRET = process.env.CONTROLLER_SECRET || "changeme";

async function request(path: string, method: string, body?: unknown) {
  const res = await fetch(`${CONTROLLER_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONTROLLER_SECRET}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(method === "POST" ? 150_000 : 10_000), // exec can take up to 120s
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Sandbox API error: ${res.status}`);
  return data;
}

/** Sanitize ID for safe use in Docker names and paths */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

export async function createSession(sessionId: string, userId: string) {
  return request("/sessions", "POST", {
    sessionId: sanitizeId(sessionId),
    userId: sanitizeId(userId),
  });
}

export function getSanitizedSessionId(chatId: string): string {
  return sanitizeId(chatId);
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

export async function listSessions() {
  return request("/sessions", "GET") as Promise<
    { id: string; userId: string; lastActivity: number }[]
  >;
}
