import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { vaultClaims, vaultEdges, vaultNodes, vaultNotes, vaultNoteVersions } from "@/lib/db/schema";
import { fitStatement } from "./claims";
import { fitNoteTitle } from "./notes";
import type { Ex } from "./spaces";

/**
 * CANONICAL EDGE TOKENS — the stored form of a link inside a note body (§7).
 *
 * A persistent link is always an id-to-id edge, and a note body names the EDGE rather than
 * the target's title. That is the `topic_key` ≠ `title` lesson applied to link text: a value
 * a person may rename is never a key. Renaming a target therefore changes every DISPLAY of
 * it and touches no note body and no edge row.
 *
 * THE MODEL CANNOT TYPE ONE. `memory_note_write` takes blocks, and a `node_link` block
 * carries a HANDLE; the server is what turns that into an edge and an edge into a token. A
 * `[[Title]]` the model types stays literal text forever — §7's "visible unresolved text"
 * case — and mints no edge. Only the person's own editor may resolve one, on save, on their
 * own page.
 *
 * The token's payload is an edge id, which is a `nanoid()` — 21 characters out of
 * `A-Za-z0-9_-`, which is why the pattern is that class and not `\w`.
 */
export const EDGE_TOKEN_RE = /\[\[capka-edge:([A-Za-z0-9_-]{1,32})\]\]/g;

export const edgeToken = (edgeId: string) => `[[capka-edge:${edgeId}]]`;

/** One block of a note's content, as the write tools take it. `markdown` text is stored
 *  verbatim; a `node_link` becomes a token and an edge, and nothing else can. */
export type NoteBlock = { kind: "markdown"; text: string } | { kind: "node_link"; targetHandle: string };

/** What separates two blocks in the stored body. Blocks are paragraph-level, so a blank
 *  line — a link block on its own line is what the renderer and the person both expect,
 *  and it keeps a link out of the middle of a sentence the model did not write. */
const BLOCK_SEPARATOR = "\n\n";

/**
 * BLOCKS -> ONE MARKDOWN BODY, with every `node_link` already resolved to the edge that
 * represents it.
 *
 * `edgeIdFor` is a lookup and not a writer: the caller creates the `references` edges first,
 * inside its own transaction, and hands this function the map. That order is fixed (§4.6,
 * §4.8) — an edge without its block would render a link the note body does not mention, and
 * a block without its edge is the unresolved-text case, which no tool may mint. Splitting
 * "make the edge" from "write the token" is what makes both halves visible at the call site.
 *
 * It THROWS on an unknown handle rather than skipping the block: a note saved with half its
 * links is the state §4.1 rejects the whole mutation for, and a serializer that silently
 * dropped one would produce exactly that.
 */
export function serializeBlocks(blocks: NoteBlock[], edgeIdFor: (handle: string) => string): string {
  return blocks
    .map((b) => {
      if (b.kind === "markdown") return b.text;
      const edgeId = edgeIdFor(b.targetHandle);
      if (!edgeId) throw new Error(`serializeBlocks: no edge for handle ${b.targetHandle}`);
      return edgeToken(edgeId);
    })
    .join(BLOCK_SEPARATOR);
}

/** `memory_link`'s half of §4.8: the body it was given plus one more link block. A separate
 *  function from `serializeBlocks` because the existing body is already serialized — parsing
 *  it back into blocks to re-serialize it would risk changing bytes the revision did not mean
 *  to touch. An empty body gains no leading separator. */
export function appendLinkBlock(bodyMarkdown: string, edgeId: string): string {
  return bodyMarkdown ? `${bodyMarkdown}${BLOCK_SEPARATOR}${edgeToken(edgeId)}` : edgeToken(edgeId);
}

/** Every edge id a body names, in order of appearance and de-duplicated. A separate function
 *  because two callers need it for different reasons — the display renderer to resolve them,
 *  and `memory_link` to append one without re-parsing the body it is about to extend. */
export function edgeIdsIn(bodyMarkdown: string): string[] {
  // A fresh regex per call: `EDGE_TOKEN_RE` is /g/ and therefore carries `lastIndex`, so a
  // shared instance would answer differently on its second call. The same trap `QUOTED`
  // documents one module over.
  const re = new RegExp(EDGE_TOKEN_RE.source, "g");
  const out: string[] = [];
  for (const m of bodyMarkdown.matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** What a token renders as when its edge is gone — soft-deleted with the target node, or
 *  from another space, or never real. NOT the token itself: the payload is a persistent id,
 *  and a display surface that printed it would put an id in front of whoever reads the note
 *  (including, through `memory_open`, the model). §7's rule is that unresolved text is never
 *  treated as a link, and this is the display half of it. */
export const UNRESOLVED_LINK = "[[link removed]]";

/**
 * TOKEN SUBSTITUTION, and the only implementation of it.
 *
 * Two callers resolve titles from two DIFFERENT places and must not each grow their own
 * substitution: the owner's display path may read any target's title, while the model-facing
 * path may only read titles its channel admits — that decision belongs to `model-view.ts`
 * and cannot be made here. So the parsing and the placeholder live here, once, and the
 * TITLE SOURCE is the parameter.
 */
export function substituteTokens(bodyMarkdown: string, titleFor: (edgeId: string) => string | null): string {
  const re = new RegExp(EDGE_TOKEN_RE.source, "g");
  return bodyMarkdown.replace(re, (_all, edgeId: string) => {
    const title = titleFor(edgeId);
    return title === null ? UNRESOLVED_LINK : `[[${title}]]`;
  });
}

/** Where a live edge in this space points, by edge id. Ids and kinds only — no text — so
 *  this is not a model-facing read and needs no channel clause. The SPACE is a parameter and
 *  not a hint: an edge id copied out of another space's note must resolve to nothing, and the
 *  composite FK guarantees only that an edge and its nodes share a space, not that the space
 *  is the caller's. */
export async function edgeTargets(
  bodyMarkdown: string,
  spaceId: string,
  ex: Ex = db,
): Promise<Map<string, { nodeId: string; kind: "note" | "claim" | "source" }>> {
  const ids = edgeIdsIn(bodyMarkdown);
  const out = new Map<string, { nodeId: string; kind: "note" | "claim" | "source" }>();
  if (!ids.length) return out;
  const rows = await ex
    .select({ id: vaultEdges.id, nodeId: vaultNodes.id, kind: vaultNodes.kind })
    .from(vaultEdges)
    .innerJoin(
      vaultNodes,
      and(eq(vaultNodes.id, vaultEdges.toNodeId), eq(vaultNodes.spaceId, vaultEdges.spaceId)),
    )
    .where(
      and(
        eq(vaultEdges.spaceId, spaceId),
        inArray(vaultEdges.id, ids),
        isNull(vaultEdges.deletedAt),
        isNull(vaultNodes.deletedAt),
      ),
    );
  for (const r of rows) out.set(r.id, { nodeId: r.nodeId, kind: r.kind });
  return out;
}

/**
 * THE OWNER's rendering of a note body: every token resolved to its target's CURRENT title.
 *
 * It reads titles with no channel clause, which is correct for the surface it serves — the
 * memory page, whose audience is the owner of the data, exactly like `memory-page.ts`'s other
 * reads. The MODEL's rendering is a mint in `model-view.ts` and calls `substituteTokens` with
 * a channel-filtered title source; that is the whole reason the substitution is a separate
 * function from this one.
 *
 * A CLAIM target has no title, so its statement stands in, clamped by `fitStatement` — the
 * same one line every other surface shows it as, but only while the claim is the LIVE head
 * and is NOT sensitive. Neither clause is a channel clause, and neither is optional here:
 *
 *   - `superseded_at IS NULL`, because a supersede does not tombstone the node. Without it a
 *     token keeps rendering the wording the space has since replaced, inside a file the
 *     reader takes to be current.
 *   - `sensitive = false`, because the owner's page promises a reveal CONTROL over exactly
 *     those words and a body is markdown, with no control anywhere inside it. The detail view
 *     gates the whole body on the NOTE's flag, which says nothing about a claim the body
 *     links; a sensitive fact reaches the reader through its own row, which has the control.
 *
 * A NOTE target contributes its HEAD version's title, and carries the second of those two
 * clauses for the identical reason. The cure has to be two-sided or it is not a cure: a
 * note version is marked by the same screen a claim is, and a secret-shaped title reaches
 * this lookup exactly as a secret-shaped statement does. There is no supersede clause on
 * this arm because a note has no successor row — its head IS the join condition.
 *
 * An excluded target therefore renders as `UNRESOLVED_LINK` — the same text a closed edge
 * gets, and the honest one: the file no longer shows a link there.
 *
 * A SOURCE target resolves to nothing in this slice and renders as `UNRESOLVED_LINK` too:
 * `references` may legally point at one (§2.4), and nothing can create the row until slice
 * 3's ingest, so the arm arrives with the writer that makes it reachable rather than as a
 * lookup against an empty table.
 */
export async function renderBody(bodyMarkdown: string, spaceId: string, ex: Ex = db): Promise<string> {
  const targets = await edgeTargets(bodyMarkdown, spaceId, ex);
  if (!targets.size) return substituteTokens(bodyMarkdown, () => null);
  const nodeIds = [...targets.values()].map((t) => t.nodeId);

  const titles = new Map<string, string>();
  const notes = await ex
    .select({ id: vaultNotes.id, title: vaultNoteVersions.title })
    .from(vaultNotes)
    .innerJoin(
      vaultNoteVersions,
      and(
        eq(vaultNoteVersions.noteId, vaultNotes.id),
        eq(vaultNoteVersions.revision, vaultNotes.currentRevision),
      ),
    )
    .where(
      and(
        eq(vaultNotes.spaceId, spaceId),
        inArray(vaultNotes.id, nodeIds),
        // The same clause the claim arm carries, for the same reason: a note version is as
        // markable as a claim — `insertNoteVersion` screens the title with `looksLikeSecret`
        // — and nothing screens a plain note's title the way `resolveTopic` screens a
        // topic's. Head-ness is the join above, so this reads the HEAD's flag and not an
        // older revision's.
        eq(vaultNoteVersions.sensitive, false),
      ),
    );
  for (const n of notes) titles.set(n.id, fitNoteTitle(n.title));
  const claims = await ex
    .select({ id: vaultClaims.id, statement: vaultClaims.statement })
    .from(vaultClaims)
    .where(
      and(
        eq(vaultClaims.spaceId, spaceId),
        inArray(vaultClaims.id, nodeIds),
        // The two clauses the mint carries, for the two reasons written above the function.
        isNull(vaultClaims.supersededAt),
        eq(vaultClaims.sensitive, false),
      ),
    );
  for (const c of claims) titles.set(c.id, fitStatement(c.statement));

  return substituteTokens(bodyMarkdown, (edgeId) => {
    const t = targets.get(edgeId);
    return t ? (titles.get(t.nodeId) ?? null) : null;
  });
}
