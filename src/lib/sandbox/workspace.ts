/**
 * Sandbox workspace addressing.
 *
 * A sandbox session (and its mounted `/workspace` folder) is keyed by a chat's
 * PROJECT when it has one, so every chat in a project shares the same files —
 * a project behaves like a shared folder. A chat with no project falls back to
 * its own id, keeping a private scratch workspace (the original behavior).
 */
export function workspaceSessionKey(chat: {
  id: string;
  projectId: string | null;
}): string {
  return chat.projectId ?? chat.id;
}
