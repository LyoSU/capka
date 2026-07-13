/** How a file/folder request addresses a workspace: a single chat's own scratch
 *  workspace, or a project's shared one. Pure + isomorphic (no server imports) so
 *  both the browser (file panel, folder bridge) and the API-query builder can use
 *  it. The server-side counterpart that turns this into a sandbox session key lives
 *  in `@/lib/sandbox/target` (it needs the DB); this only carries the ids. */
export type WorkspaceTarget = { kind: "chat"; chatId: string } | { kind: "project"; projectId: string };

export const chatTarget = (chatId: string): WorkspaceTarget => ({ kind: "chat", chatId });
export const projectTarget = (projectId: string): WorkspaceTarget => ({ kind: "project", projectId });

/** The query-string fragment that addresses this target on the sandbox/folders
 *  API routes (`chatId=…` or `projectId=…`). */
export function targetQuery(t: WorkspaceTarget): string {
  return t.kind === "chat"
    ? `chatId=${encodeURIComponent(t.chatId)}`
    : `projectId=${encodeURIComponent(t.projectId)}`;
}

/** A stable identity string for caching / React keys, distinct per target. */
export function targetKey(t: WorkspaceTarget): string {
  return t.kind === "chat" ? `c:${t.chatId}` : `p:${t.projectId}`;
}
