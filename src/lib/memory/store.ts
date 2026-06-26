import { and, eq, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { LanguageModel, ModelMessage } from "ai";
import type { TokenUsage } from "@/lib/pricing";
import { db } from "@/lib/db";
import { memoryDocs } from "@/lib/db/schema";
import {
  reconcileMemoryDoc,
  consolidateMemoryDoc,
  applyMemoryOps,
  needsConsolidation,
  clampDoc,
  type MemoryScope,
  type ConversationTurn,
} from "./doc";

type DocRow = typeof memoryDocs.$inferSelect;

const scopeFilter = (userId: string, projectId: string | null) =>
  projectId == null
    ? and(eq(memoryDocs.userId, userId), isNull(memoryDocs.projectId))
    : and(eq(memoryDocs.userId, userId), eq(memoryDocs.projectId, projectId));

/** The two docs a run sees: the user-global doc always, plus the current
 *  project's doc when in a project. Empty strings when a scope has no doc yet. */
export async function readMemoryDocs(
  userId: string,
  projectId: string | null,
): Promise<{ user: string; project: string }> {
  const rows = await db
    .select({ content: memoryDocs.content, projectId: memoryDocs.projectId })
    .from(memoryDocs)
    .where(
      projectId
        ? and(eq(memoryDocs.userId, userId), or(isNull(memoryDocs.projectId), eq(memoryDocs.projectId, projectId)))
        : and(eq(memoryDocs.userId, userId), isNull(memoryDocs.projectId)),
    );
  return {
    user: rows.find((r) => r.projectId == null)?.content ?? "",
    project: projectId ? (rows.find((r) => r.projectId === projectId)?.content ?? "") : "",
  };
}

async function getOrInit(userId: string, projectId: string | null): Promise<DocRow | undefined> {
  const found = await db.select().from(memoryDocs).where(scopeFilter(userId, projectId)).limit(1);
  if (found[0]) return found[0];
  // Concurrent first-writes race the unique index; ignore the loser and re-read.
  await db.insert(memoryDocs).values({ id: nanoid(), userId, projectId: projectId ?? null }).onConflictDoNothing();
  return (await db.select().from(memoryDocs).where(scopeFilter(userId, projectId)).limit(1))[0];
}

type Transform = (fresh: DocRow) => Promise<{ content: string; turnsSinceConsolidation: number }> | { content: string; turnsSinceConsolidation: number };

/**
 * Apply a transform under optimistic concurrency: read the row, compute the
 * next content, and write only if `version` hasn't moved. Two chats in one
 * project can race the same doc; on conflict we re-read and re-run the transform
 * once (transforms are deterministic line edits, so re-applying is correct and
 * cheap). A no-op transform writes nothing.
 */
async function optimisticUpdate(
  userId: string,
  projectId: string | null,
  transform: Transform,
  seed?: DocRow,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = attempt === 0 && seed ? seed : await getOrInit(userId, projectId);
    if (!fresh) return;
    const next = await transform(fresh);
    if (next.content === fresh.content && next.turnsSinceConsolidation === fresh.turnsSinceConsolidation) return;
    const written = await db
      .update(memoryDocs)
      .set({
        content: next.content,
        prevContent: fresh.content,
        version: fresh.version + 1,
        turnsSinceConsolidation: next.turnsSinceConsolidation,
        updatedAt: new Date(),
      })
      .where(and(eq(memoryDocs.id, fresh.id), eq(memoryDocs.version, fresh.version)))
      .returning({ id: memoryDocs.id });
    if (written.length > 0) return;
  }
}

/**
 * Fold the just-finished turn into the scope's memory doc (fire-and-forget from
 * the runner). One reconcile LLM call → line ops → apply; a periodic
 * consolidation rewrite is folded into the same write when due. Skips all I/O
 * when there's nothing to add and consolidation isn't due, so quiet turns are free.
 */
export async function maintainMemoryDoc(opts: {
  model: LanguageModel;
  provider: string;
  userId: string;
  projectId: string | null;
  scope: MemoryScope;
  turn: ConversationTurn;
  onUsage?: (usage: TokenUsage) => void;
  hotContext?: { systemMessages: ModelMessage[]; modelMessages: ModelMessage[] };
}): Promise<void> {
  const current = await getOrInit(opts.userId, opts.projectId);
  if (!current) return;

  const ops = await reconcileMemoryDoc(opts.model, opts.provider, opts.scope, current.content, opts.turn, opts.onUsage, opts.hotContext);
  if (ops.length === 0 && !needsConsolidation(current.content, current.turnsSinceConsolidation + 1)) return;

  await optimisticUpdate(
    opts.userId,
    opts.projectId,
    async (fresh) => {
      let content = applyMemoryOps(fresh.content, ops);
      let turns = fresh.turnsSinceConsolidation + 1;
      if (needsConsolidation(content, turns)) {
        content = await consolidateMemoryDoc(opts.model, opts.provider, content, opts.onUsage);
        turns = 0;
      }
      return { content, turnsSinceConsolidation: turns };
    },
    current,
  );
}

/** Agent-curated capture: deliberately add a fact (the `remember` tool). */
export function rememberFact(userId: string, projectId: string | null, text: string): Promise<void> {
  return optimisticUpdate(userId, projectId, (fresh) => ({
    content: applyMemoryOps(fresh.content, [{ op: "add", text }]),
    turnsSinceConsolidation: fresh.turnsSinceConsolidation,
  }));
}

/** Agent-curated removal: drop facts matching a substring (the `forget` tool). */
export function forgetFact(userId: string, projectId: string | null, match: string): Promise<void> {
  return optimisticUpdate(userId, projectId, (fresh) => ({
    content: applyMemoryOps(fresh.content, [{ op: "remove", text: match }]),
    turnsSinceConsolidation: fresh.turnsSinceConsolidation,
  }));
}

/** Hand-edit from settings: overwrite the doc verbatim (clamped to the ceiling). */
export function setMemoryDoc(userId: string, projectId: string | null, content: string): Promise<void> {
  return optimisticUpdate(userId, projectId, (fresh) => ({
    content: clampDoc(content),
    turnsSinceConsolidation: fresh.turnsSinceConsolidation,
  }));
}
