import { loadActivePath } from "./tree";
import { toUIMessages } from "./presenter";
import { readTurnWrites } from "@/lib/vault/turn-writes";

/**
 * The web transcript of a chat the caller has ALREADY checked is `userId`'s: the
 * active branch (root → `activeLeafId`), each node with its "‹ i/N ›" sibling
 * position and the turn's "saved to memory" notice. With `turnOf`, that one turn
 * onward instead — what a client already holding the rest needs after `task:finish`;
 * empty when that message is not on the active branch.
 *
 * One function for both readers of it, GET /api/chat and the chat page that hands
 * its first paint the same answer, so the two cannot drift apart.
 */
export async function loadTranscript(chatId: string, userId: string, activeLeafId: string | null, turnOf?: string) {
  const path = await loadActivePath(chatId, activeLeafId, turnOf);
  const rows = path.map((p) => ({ ...p.node, siblingIndex: p.siblingIndex, siblingCount: p.siblingCount }));
  // One extra read for the whole visible branch rather than one per message, and
  // passed to the presenter rather than merged into `rows`: the web transcript is
  // the ONLY reader that renders the notice, and the share page must never be given
  // the shape by accident.
  const memoryWrites = await readTurnWrites(rows.map((r) => r.id), userId);
  return toUIMessages(rows, memoryWrites);
}
