import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chats, messages } from "@/lib/db/schema";

/**
 * The conversation tree.
 *
 * Messages form a tree via `parentId`; each chat pins one `activeLeafId`. The
 * visible conversation is the chain from that leaf up to the root. Editing a
 * message or regenerating a reply inserts a *sibling* (same parent) and moves
 * the leaf — nothing is ever deleted, so every version stays reachable and you
 * can switch between them.
 *
 * The graph logic lives in pure functions (no DB) so it is exhaustively unit
 * testable; the exported async wrappers are thin adapters over Drizzle.
 */

/** Minimal shape the graph math needs. */
export interface TreeNode {
  id: string;
  parentId: string | null;
  createdAt: Date | null;
}

export interface PathEntry<T extends TreeNode> {
  node: T;
  /** 0-based position of this node among its siblings (by createdAt, then id). */
  siblingIndex: number;
  /** How many siblings share this node's parent (1 = no alternatives). */
  siblingCount: number;
}

/** Stable sibling ordering: oldest first, id as a deterministic tiebreak. */
function bySiblingOrder(a: TreeNode, b: TreeNode): number {
  const at = a.createdAt?.getTime() ?? 0;
  const bt = b.createdAt?.getTime() ?? 0;
  return at !== bt ? at - bt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Group nodes by parentId, each group sorted in sibling order. */
function childrenByParent<T extends TreeNode>(rows: T[]): Map<string | null, T[]> {
  const map = new Map<string | null, T[]>();
  for (const r of [...rows].sort(bySiblingOrder)) {
    const list = map.get(r.parentId);
    if (list) list.push(r);
    else map.set(r.parentId, [r]);
  }
  return map;
}

/**
 * Follow the newest child at each step until a leaf is reached. Used both to
 * resolve a stale/empty active pointer and to land on a concrete leaf after a
 * branch switch. Returns `fromId` itself if it has no children.
 */
export function descendToLeaf<T extends TreeNode>(rows: T[], fromId: string): string {
  const kids = childrenByParent(rows);
  let currentId = fromId;
  const guard = new Set<string>(); // cycles can't happen in a tree, but never loop forever
  while (!guard.has(currentId)) {
    guard.add(currentId);
    const cs = kids.get(currentId);
    if (!cs || cs.length === 0) return currentId;
    currentId = cs[cs.length - 1].id; // newest child
  }
  return currentId;
}

/**
 * The visible conversation: root → active leaf, each node annotated with its
 * position among siblings. If `activeLeafId` is missing or stale, falls back to
 * the newest branch (descend from the newest root) so the chat is never blank
 * just because the pointer drifted.
 */
export function activePath<T extends TreeNode>(rows: T[], activeLeafId: string | null): PathEntry<T>[] {
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = childrenByParent(rows);

  let leaf = activeLeafId ? byId.get(activeLeafId) : undefined;
  if (!leaf) {
    const roots = kids.get(null);
    if (!roots || roots.length === 0) return []; // forest with no reachable root
    leaf = byId.get(descendToLeaf(rows, roots[roots.length - 1].id));
  }
  if (!leaf) return [];

  // Walk leaf → root (guarded against malformed parent chains), then reverse.
  const chain: T[] = [];
  const seen = new Set<string>();
  let cur: T | undefined = leaf;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();

  return chain.map((node) => {
    const sibs = kids.get(node.parentId) ?? [node];
    return { node, siblingIndex: sibs.findIndex((s) => s.id === node.id), siblingCount: sibs.length };
  });
}

// ── DB adapters ──────────────────────────────────────────────

type MessageRow = typeof messages.$inferSelect;
export type PathRow = PathEntry<MessageRow>;

/** All messages of a chat — small, bounded set; the graph math runs in memory. */
async function loadMessages(chatId: string): Promise<MessageRow[]> {
  return db.select().from(messages).where(eq(messages.chatId, chatId));
}

/** The visible conversation for a chat, root → active leaf, with sibling info. */
export async function loadActivePath(chatId: string, activeLeafId: string | null): Promise<PathRow[]> {
  return activePath(await loadMessages(chatId), activeLeafId);
}

/**
 * The id of the sibling one step `prev`/`next` from `messageId` in sibling
 * order, or null if there is none (already at an edge, or unknown id). Pure so
 * the version switcher's logic is fully unit-tested.
 */
export function siblingId<T extends TreeNode>(
  rows: T[],
  messageId: string,
  direction: "prev" | "next",
): string | null {
  const node = rows.find((r) => r.id === messageId);
  if (!node) return null;
  const sibs = childrenByParent(rows).get(node.parentId) ?? [];
  const idx = sibs.findIndex((s) => s.id === messageId);
  if (idx === -1) return null;
  const target = direction === "next" ? idx + 1 : idx - 1;
  return sibs[target]?.id ?? null;
}

/**
 * Flip the visible branch to `messageId`'s neighbouring sibling and descend to
 * its leaf, pinning the chat there. Returns the new leaf id, or null if there
 * is no sibling in that direction.
 */
export async function switchSibling(
  chatId: string,
  messageId: string,
  direction: "prev" | "next",
): Promise<string | null> {
  const rows = await loadMessages(chatId);
  const target = siblingId(rows, messageId, direction);
  if (!target) return null;
  const leafId = descendToLeaf(rows, target);
  await db.update(chats).set({ activeLeafId: leafId, updatedAt: new Date() }).where(eq(chats.id, chatId));
  return leafId;
}

/**
 * Copy the path root → `fromMessageId` of `sourceChatId` into a brand-new chat
 * owned by `userId` (same project), so the user can explore from that point
 * without touching the original. Returns the new chat id.
 */
export async function forkChat(opts: {
  sourceChatId: string;
  fromMessageId: string;
  userId: string;
}): Promise<string | null> {
  const { sourceChatId, fromMessageId, userId } = opts;
  const [source] = await db.select().from(chats).where(eq(chats.id, sourceChatId)).limit(1);
  if (!source) return null;

  const rows = await loadMessages(sourceChatId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (!byId.has(fromMessageId)) return null;

  // Path from the chosen node up to the root, then root → node.
  const chain: MessageRow[] = [];
  const seen = new Set<string>();
  let cur: MessageRow | undefined = byId.get(fromMessageId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();

  const newChatId = nanoid();
  const idMap = new Map<string, string>();
  const copies = chain.map((node) => {
    const newId = nanoid();
    idMap.set(node.id, newId);
    return {
      id: newId,
      chatId: newChatId,
      parentId: node.parentId ? idMap.get(node.parentId) ?? null : null,
      role: node.role,
      content: node.content,
      platform: node.platform,
      metadata: node.metadata,
    };
  });

  await db.transaction(async (tx) => {
    await tx.insert(chats).values({
      id: newChatId,
      userId,
      projectId: source.projectId,
      title: `${source.title ?? "Chat"} (копія)`,
      model: source.model,
    });
    if (copies.length > 0) {
      await tx.insert(messages).values(copies);
      await tx.update(chats)
        .set({ activeLeafId: copies[copies.length - 1].id })
        .where(eq(chats.id, newChatId));
    }
  });

  return newChatId;
}
