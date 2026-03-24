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
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Sandbox API error: ${res.status}`);
  return data;
}

export async function createSession(sessionId: string, userId: string) {
  return request("/sessions", "POST", { sessionId, userId });
}

export async function execCommand(sessionId: string, command: string, timeout?: number) {
  return request(`/sessions/${sessionId}/exec`, "POST", { command, timeout }) as Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

export async function destroySession(sessionId: string) {
  return request(`/sessions/${sessionId}`, "DELETE");
}

export async function listSessions() {
  return request("/sessions", "GET") as Promise<
    { id: string; userId: string; lastActivity: number }[]
  >;
}
