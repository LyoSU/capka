import { MEMORY_OPEN_MAX_BYTES } from "./budget";
import type { SourceClass } from "./claims";
import type { HandleKind } from "./handles";
import { pageLines } from "./line-view";
import type { NodeKind } from "./nodes";
import {
  openClaimForModel,
  openNoteForModel,
  openSourceForModel,
  type EvidenceText,
  type MemoryToolText,
} from "./model-view";
import type { WriteCtx } from "./write-tools";

/**
 * THE READ HALF OF THE MEMORY TOOLS — `memory_open` (§4.3).
 *
 * A module of its own beside `write-tools.ts` for the reason that file gives for existing at
 * all: the two halves answer different questions. `write-tools.ts` decides what the model may
 * STORE; this decides how ONE stored item is handed back when the model asks for it by
 * handle. (`memory_search` stays in `tools.ts` with the factory, because what it needs is the
 * per-turn closure and not a writer's context.)
 *
 * It is MODEL-FACING, and `model-view.test.ts` walks it as such. Everything it returns as
 * prose is minted by `model-view.ts` — this file composes no text out of a row it read,
 * because it reads no rows at all. §3.4's NEW-3 is explicit that an implementer wiring
 * `memory_open(handle)` straight to a row read would re-open, one tool over, the leak N4
 * closed; the way that is prevented here is that there is no database import in this file.
 *
 * It shares `WriteCtx`, which is the one thing a reader and a writer genuinely have in
 * common: the handle map, the taint and the budget all have the TURN's lifetime, and a second
 * context would give the turn a second answer to "what can I see".
 */

export type MemoryOpenStatus = "opened" | "not_found" | "off_channel" | "wrong_kind" | "bad_cursor";

/** A node kind to the HANDLE LETTER that addresses it. Written as a total map so a fourth
 *  node kind is a compile error here rather than a link the model cannot follow. */
const HANDLE_FOR_NODE = { note: "n", claim: "m", source: "f" } satisfies Record<NodeKind, HandleKind>;

/**
 * §4.3's sentences, and two of them are the section's own findings.
 *
 * `off_channel` is reachable in ordinary use and is not a scolding: the model can hold a
 * handle to a note IT wrote a step ago whose class puts it on the evidence channel, so the
 * sentence says what the item is rather than implying the address was wrong.
 *
 * `wrong_kind` for a `g` handle is §4.3's own wording — an edge is not readable on its own
 * (L6) — and it points at the one thing that IS readable, which is either endpoint.
 */
export const OPEN_SAID: Record<MemoryOpenStatus, string> = {
  opened: "",
  not_found: "There is nothing at that address. Run memory_search and use a handle it returned.",
  off_channel:
    "That item came from a document or a web page, so it is not readable as memory. It is stored and the user can see it; do not assert it as a fact.",
  wrong_kind: "An edge is not readable on its own - open one of its endpoints.",
  bad_cursor: "That cursor is not one this tool handed out. Call memory_open again without a cursor.",
};

/** The `f` arm's pointer, and §4.3's own sentence for it. It is UNREACHABLE in this slice —
 *  nothing mints an `f` handle before slice 3's ingest — which is exactly why it may name
 *  `knowledge_search`: by the time a turn can hold one, the turn holds that tool too. The
 *  same reasoning read the other way is why `ABSENCE_NOTE` drops its `knowledge_search`
 *  half: that line ships on every `memory_search` reply TODAY. */
const OPEN_FILE_POINTER = "Use knowledge_search to read inside this document.";

/** The `e` arm. §4.3 gives a fragment its `model_text` excerpt and its locator; that text is
 *  `listEvidenceRows`' to mint and `knowledge_fragments` has no `model_text` column until
 *  slice 3's ingest writes the projection — so rendering one HERE would be the fifth text
 *  producer NEW-3 forbids, out of a column that does not exist yet. Like the `f` arm it is
 *  unreachable in this slice; unlike it, its data path is missing too, so it refuses. */
const OPEN_FRAGMENT_DEFERRED =
  "A document fragment is read where it was found, not on its own. Search the document instead.";

export type MemoryOpenResult =
  | {
      status: "opened";
      kind: "claim";
      handle: string;
      revision: number;
      statement: MemoryToolText;
      topic: MemoryToolText | null;
      sourceClass: SourceClass;
      recordedAt: string;
      /** THE HANDLE AND THE TRUST TAG ONLY, never the contesting statement's text (N4). The
       *  pointer in `said` is a call the model CAN make with what it is holding, which round
       *  2's `knowledge_search` pointer was not — that tool takes queries, not handles. */
      conflict: { handle: string; trust: SourceClass } | null;
      said: string;
    }
  | {
      status: "opened";
      kind: "note";
      handle: string;
      revision: number;
      title: MemoryToolText;
      body: string;
      sourceClass: SourceClass;
      staleSince: string | null;
      /** Handles, never ids. Capped by the mint. */
      contains: string[];
      links: string[];
      /** Where the next page starts, or `null` when this one is the last. An opaque token as
       *  far as the model is concerned. */
      cursor: string | null;
      said: string;
    }
  | {
      status: "opened";
      kind: "source";
      handle: string;
      title: EvidenceText;
      versions: { observedAt: string; status: string; superseded: boolean }[];
      said: string;
    }
  | { status: "not_found" | "off_channel" | "wrong_kind" | "bad_cursor"; said: string };

/**
 * THE HEADER OF A NOTE PAGE, in the shape Claude's own file view uses, because that is the
 * format the model already knows how to read and to address.
 *
 * It NAMES THE TITLE, and doing so mints nothing: the value interpolated is the one this
 * function was handed by `openNoteForModel`, and it also travels on the reply's own `title`
 * field. Reading a title out of a row here would be the leak §3.4's NEW-3 is about; quoting
 * the mint's own answer back is not.
 */
const noteHeader = (title: string, revision: number, from: number, to: number, total: number) =>
  `Here's the content of «${title}» (revision ${revision}, lines ${from}-${to} of ${total}) with line numbers:`;

/**
 * `memory_open` (§4.3): one saved item, in full, addressed by the handle a search returned.
 *
 * IT MINTS, IT DOES NOT READ ROWS. Every arm calls the mint for its kind and hands back what
 * that mint returned; an off-channel row is REFUSED rather than rendered, and this function
 * has no way to render one because it never holds the row.
 */
export async function memoryOpen(a: {
  handle: string;
  cursor?: string;
  maxBytes?: number;
  ctx: WriteCtx;
}): Promise<MemoryOpenResult> {
  const { ctx } = a;
  const allowedSpaceIds = ctx.projectSpaceId ? [ctx.userSpaceId, ctx.projectSpaceId] : [ctx.userSpaceId];
  const t = ctx.handles.resolve(a.handle);
  if (!t || !allowedSpaceIds.includes(t.spaceId)) return { status: "not_found", said: OPEN_SAID.not_found };
  // `g` FIRST, because §4.3 gives it a sentence of its own and it is the one letter whose
  // target is not a node at all: `nodeId` carries an edge id for a `g` handle.
  if (t.kind === "g") return { status: "wrong_kind", said: OPEN_SAID.wrong_kind };
  if (t.kind === "e") return { status: "wrong_kind", said: OPEN_FRAGMENT_DEFERRED };

  if (t.kind === "m") {
    const out = await openClaimForModel(t.spaceId, t.nodeId);
    if (!out.ok) return { status: out.reason, said: OPEN_SAID[out.reason] };
    const c = out.item;
    return {
      status: "opened",
      kind: "claim",
      handle: a.handle,
      revision: c.revision,
      statement: c.statement,
      topic: c.topic,
      sourceClass: c.sourceClass,
      recordedAt: c.recordedAt.toISOString(),
      conflict: c.conflict
        ? {
            handle: ctx.handles.mint({ kind: "m", spaceId: c.conflict.spaceId, nodeId: c.conflict.nodeId }),
            trust: c.conflict.trust,
          }
        : null,
      // The pointer is `memory_open` on the conflicting handle — the one handle-addressed
      // reader there is — and NOT `knowledge_search`, which takes queries and could not be
      // called with what the model is holding (NEW-3). That call then mints through the
      // conflicting row's own channel, or refuses, so the contesting statement stays
      // reachable only through a mint.
      said: c.conflict
        ? "A contested entry exists (from a document). Open it with memory_open on that handle."
        : "",
    };
  }

  if (t.kind === "n") {
    const out = await openNoteForModel(t.spaceId, t.nodeId);
    if (!out.ok) return { status: out.reason, said: OPEN_SAID[out.reason] };
    const n = out.item;
    const p = pageLines(n.body, a.cursor, a.maxBytes ?? MEMORY_OPEN_MAX_BYTES);
    if (!p) return { status: "bad_cursor", said: OPEN_SAID.bad_cursor };
    return {
      status: "opened",
      kind: "note",
      handle: a.handle,
      revision: n.revision,
      title: n.title,
      // The page, not the brand: a SLICE of `MemoryToolText` is a plain string, and typing it
      // back to the brand here would be this module minting. The LINE NUMBERS added around
      // it carry no content of the row — they are the value's own line structure counted —
      // so the bytes that came out of the mint are still the only text of the row here.
      body: p.text,
      sourceClass: n.sourceClass,
      staleSince: n.staleSince?.toISOString() ?? null,
      contains: n.containedClaimIds.map((id) => ctx.handles.mint({ kind: "m", spaceId: t.spaceId, nodeId: id })),
      // The LETTER follows the target's node kind, which the mint reports: a link may point
      // at a note, a fact or a document, and handing the model an `n` for a claim would be an
      // address that resolves to the wrong reader.
      links: n.linkTargets.map((x) =>
        ctx.handles.mint({ kind: HANDLE_FOR_NODE[x.kind], spaceId: t.spaceId, nodeId: x.nodeId }),
      ),
      cursor: p.next,
      said: `${noteHeader(n.title, n.revision, p.from, p.to, p.total)}${
        p.next ? " There is more of this note - call memory_open again with the cursor to read on." : ""
      }`,
    };
  }

  const out = await openSourceForModel(t.spaceId, t.nodeId);
  if (!out.ok) return { status: out.reason, said: OPEN_SAID[out.reason] };
  // THE ONE ARM THAT READS OFF THE MEMORY CHANNEL, so it marks the turn itself. The memory
  // tools are registered `untrustedOutput: false` (see `capkaAuthored` in `tools.ts`) on the
  // strength of every other arm minting through the memory-tool channel; a document's title
  // is evidence-channel text a person or an upload supplied, and a turn that read it has
  // read outside content exactly as a `knowledge_search` turn will have in slice 3.
  await ctx.taint.mark("tool_result");
  return {
    status: "opened",
    kind: "source",
    handle: a.handle,
    title: out.item.title,
    versions: out.item.versions.map((v) => ({
      observedAt: v.observedAt.toISOString(),
      status: v.status,
      superseded: v.superseded,
    })),
    // METADATA ONLY. There is no arm above that could dump a file: the only text this reads
    // is the title a person gave the document.
    said: OPEN_FILE_POINTER,
  };
}
