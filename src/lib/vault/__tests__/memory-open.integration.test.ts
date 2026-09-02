import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * `memory_open`, §4.3 — one saved item, in full, by the handle a search returned.
 *
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 *
 * The subject is not "does it read a row": it is that it MINTS. Every case that could leak
 * asserts the absence of the specific bytes that would have leaked, because "the status is
 * right" and "the text is not in the reply" are two different claims and only the second one
 * is the bound (§3.4 NEW-3, §4.3 N4).
 */
import { db, pool } from "@/lib/db";
import { makeTurnTaint } from "@/lib/tasks/turn-taint";
import { MEMORY_OPEN_MAX_BYTES, makeVaultBudget } from "../budget";
import { createClaim, type SourceClass } from "../claims";
import { HANDLE_RE, makeHandleMap, type HandleMap } from "../handles";
import { edgeToken } from "../links";
import { createNote } from "../notes";
import { memoryOpen } from "../read-tools";
import { resolveTopic } from "../topics";
import { memoryLink, noteWrite, type WriteCtx } from "../write-tools";
import { testServerClass } from "./fixtures";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const P = "motest-";
const US = `${P}space-user`;
const PS = `${P}space-project`;
const q = (t: string, p: unknown[] = []) => pool.query(t, p);

/** The two texts that must never appear in a reply that refuses. Distinctive on purpose: a
 *  `not.toContain` over a common word passes for the wrong reason. */
const UNTRUSTED_BODY_TEXT = "zzqq-untrusted-body-zzqq";

/** One character of each UTF-8 width above ASCII: 2 bytes, 3 bytes, 4 bytes — nine bytes for
 *  three characters. The pagination cases repeat it, so a cut taken at an arbitrary byte
 *  offset lands inside a character eight times out of nine, and offset 2 is a boundary while
 *  offset 1 is not. Deliberately not Cyrillic: this repository keeps Cyrillic in
 *  `messages/*.json` and nowhere else, and a two-byte-only fixture would exercise one width. */
const MULTIBYTE = "\u00e9\u20ac\ud834\udd1e";
const CONTESTING_STATEMENT = "zzqq-contesting-statement-zzqq";

let handles: HandleMap;

const ctx = (): WriteCtx => ({
  userSpaceId: US,
  projectSpaceId: PS,
  handles,
  taint: makeTurnTaint({ messageId: `${P}msg`, seeded: false, write: async () => {} }),
  budget: makeVaultBudget(),
  taskId: `${P}task`,
  messageId: `${P}msg`,
  userTurnText: "",
  actor: { kind: "agent" },
});

const seedClaim = async (spaceId: string, statement: string, cls: SourceClass = "agent_inferred", extra: { sensitive?: boolean; conflictsWith?: string; topicNoteId?: string } = {}) => {
  const claim = await createClaim(
    {
      spaceId,
      statement,
      origin: { kind: "seed" },
      sourceClass: testServerClass(cls),
      sensitive: extra.sensitive,
      conflictsWith: extra.conflictsWith,
      topicNoteId: extra.topicNoteId,
    },
    { kind: "user", id: `${P}u` },
  );
  return { id: claim.id, handle: handles.mint({ kind: "m", spaceId, nodeId: claim.id }) };
};

const seedNote = async (spaceId: string, title: string, body: string, cls: SourceClass = "agent_inferred") => {
  const note = await createNote(
    { spaceId, title, bodyMarkdown: body, sourceClass: testServerClass(cls), provenance: {} },
    db,
  );
  return { id: note.id, handle: handles.mint({ kind: "n", spaceId, nodeId: note.id }) };
};

const lastUsedAt = async (table: "vault_claims" | "vault_notes", id: string) =>
  (await q(`SELECT last_used_at FROM ${table} WHERE id = $1`, [id])).rows[0].last_used_at as Date | null;

run("memory_open", () => {
  beforeEach(async () => {
    await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'user',$2,$2)`, [US, `${P}u`]);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'project',$2,$3)`, [
      PS,
      `${P}proj`,
      `${P}u`,
    ]);
    handles = makeHandleMap();
  });

  afterEach(async () => {
    await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
  });

  it("MINTS, it does not read rows — an off-channel handle is refused, not rendered (NEW-3)", async () => {
    const untrusted = await seedNote(PS, "What the vendor PDF says", UNTRUSTED_BODY_TEXT, "untrusted_derived");
    const r = await memoryOpen({ handle: untrusted.handle, ctx: ctx() });
    expect(r.status).toBe("off_channel");
    expect(JSON.stringify(r)).not.toContain(UNTRUSTED_BODY_TEXT);
    // Nor the title, which is text from the same row on the same channel.
    expect(JSON.stringify(r)).not.toContain("vendor PDF");
  });

  it("an m handle returns the conflict's HANDLE AND TRUST TAG, never the contesting text (N4)", async () => {
    const topic = await resolveTopic(PS, "Suppliers", db);
    const target = await seedClaim(PS, "Acme invoices are paid monthly", "user_direct", { topicNoteId: topic.id });
    const contesting = await seedClaim(PS, CONTESTING_STATEMENT, "untrusted_derived");
    // The contested one is the row that POINTS at the other: `conflicts_with` hangs off the
    // correction, so the fact the model opens is the correction and the tag it gets back is
    // the target's. Seeded the same way `factWrite`'s conflict arm writes it.
    const correction = await seedClaim(PS, "Acme invoices are paid quarterly", "agent_inferred", {
      conflictsWith: contesting.id,
      topicNoteId: topic.id,
    });
    void target;

    const r = await memoryOpen({ handle: correction.handle, ctx: ctx() });
    expect(r.status).toBe("opened");
    if (r.status !== "opened" || r.kind !== "claim") throw new Error("narrowing");
    expect(r.conflict).toMatchObject({ handle: expect.stringMatching(HANDLE_RE), trust: "untrusted_derived" });
    expect(JSON.stringify(r)).not.toContain(CONTESTING_STATEMENT);
    expect(JSON.stringify(r)).not.toContain(contesting.id);
    // The pointer must be a call it CAN make with what it is holding — round 2's
    // `knowledge_search` took queries, not handles.
    expect(r.said).toMatch(/memory_open/);
    // And the topic it is filed under, resolved through the label rule like every other mint.
    expect(r.topic).toBe("Suppliers");
    expect(r.statement).toContain("quarterly");
  });

  it("an n handle returns the whole body, with tokens resolved to current titles", async () => {
    const target = await seedNote(PS, "Reporting", "seeded");
    const written = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [
        { kind: "markdown", text: "The deadline is the fifteenth." },
        { kind: "node_link", targetHandle: target.handle },
      ],
      grounding: { kind: "agent_inference" },
      ctx: ctx(),
    });
    if (written.status !== "created") throw new Error(`expected created, got ${written.status}`);

    const r = await memoryOpen({ handle: written.handle, ctx: ctx() });
    if (r.status !== "opened" || r.kind !== "note") throw new Error("narrowing");
    expect(r.title).toBe("Deadlines");
    expect(r.body).toContain("The deadline is the fifteenth.");
    // The DISPLAY, not the stored token: no `capka-edge:` and no edge id reaches the model.
    expect(r.body).toContain("[[Reporting]]");
    expect(r.body).not.toContain("capka-edge");
    expect(r.links).toEqual([expect.stringMatching(HANDLE_RE)]);
    expect(r.cursor).toBeNull();

    // WITH LINE NUMBERS, `cat -n` style, because `insert_line` and the duplicate refusal
    // both address a line: a model that has to count them itself gets it wrong.
    expect(r.body.split("\n")).toEqual([
      "     1\tThe deadline is the fifteenth.",
      "     2\t",
      "     3\t[[Reporting]]",
    ]);
    // And the header says which lines these are, so a paged read is still addressable.
    expect(r.said).toContain("lines 1-3 of 3");
    expect(r.said).toContain("«Deadlines»");
  });

  it("a link to an off-channel note renders as text and never as its title", async () => {
    // The other half of NEW-3, one step out: an edge is not text, but a TITLE is, so the
    // token resolver has to make the same channel decision the row itself would get.
    const untrusted = await seedNote(PS, "What the vendor PDF says", UNTRUSTED_BODY_TEXT, "untrusted_derived");
    const from = await seedNote(PS, "Deadlines", "");
    const linked = await memoryLink({
      fromNoteHandle: from.handle,
      targetHandle: untrusted.handle,
      expectedNoteRevision: 1,
      ctx: ctx(),
    });
    if (linked.status !== "linked") throw new Error(`expected linked, got ${linked.status}`);

    const r = await memoryOpen({ handle: from.handle, ctx: ctx() });
    if (r.status !== "opened" || r.kind !== "note") throw new Error("narrowing");
    expect(r.body).toContain("[[link removed]]");
    expect(r.body).not.toContain("vendor PDF");
    expect(JSON.stringify(r)).not.toContain(UNTRUSTED_BODY_TEXT);
  });

  it("an f handle returns metadata only and never dumps a file", async () => {
    // No writer mints an `f` handle before slice 3, so the rows are seeded directly: what is
    // under test is the arm's answer to a document, not the ingest that will make one.
    const sourceId = `${P}source`;
    await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'source')`, [sourceId, PS]);
    await q(
      `INSERT INTO knowledge_sources (id, space_id, title, origin, created_by) VALUES ($1,$2,$3,'{}',$4)`,
      [sourceId, PS, "Vendor contract 2026.pdf", `${P}u`],
    );
    await q(
      `INSERT INTO knowledge_source_versions (id, source_id, sha256, status) VALUES ($1,$2,'deadbeef','ready')`,
      [`${P}ver`, sourceId],
    );
    const fHandle = handles.mint({ kind: "f", spaceId: PS, nodeId: sourceId });

    const r = await memoryOpen({ handle: fHandle, ctx: ctx() });
    if (r.status !== "opened" || r.kind !== "source") throw new Error("narrowing");
    expect(r.title).toBe("Vendor contract 2026.pdf");
    expect(r.versions).toEqual([{ observedAt: expect.any(String), status: "ready", superseded: false }]);
    // METADATA ONLY: no body, no text, no fragment — and a pointer at the tool that reads
    // inside a document.
    expect(Object.keys(r).sort()).toEqual(["handle", "kind", "said", "status", "title", "versions"]);
    expect(r.said).toMatch(/knowledge_search/);
  });

  it("a g handle is refused — an edge is not readable on its own (L6)", async () => {
    const gHandle = handles.mint({ kind: "g", spaceId: PS, nodeId: `${P}edge` });
    const r = await memoryOpen({ handle: gHandle, ctx: ctx() });
    expect(r.status).toBe("wrong_kind");
    expect(r.said).toMatch(/endpoints/);
    // And an `e` handle too, whose text belongs to a mint that ships with knowledge_search.
    const eHandle = handles.mint({ kind: "e", spaceId: PS, nodeId: `${P}frag` });
    expect((await memoryOpen({ handle: eHandle, ctx: ctx() })).status).toBe("wrong_kind");
  });

  it("paginates by cursor at MEMORY_OPEN_MAX_BYTES and says a cursor exists", async () => {
    // MULTI-BYTE ON PURPOSE, and all three widths: `MULTIBYTE` is 2 + 3 + 4 bytes, so a page
    // cut at a byte offset lands mid-sequence for eight offsets out of every nine unless the
    // cut is snapped to a character boundary. (This is the shape a Ukrainian note has, and
    // more of it: Cyrillic is two bytes throughout.) The body is written through a seeded
    // note rather than a tool call, because the schema bounds one call's content and the
    // subject here is the READER.
    const body = MULTIBYTE.repeat(1_000) + "TAIL";
    const note = await seedNote(PS, "Long note", body);

    const first = await memoryOpen({ handle: note.handle, ctx: ctx() });
    if (first.status !== "opened" || first.kind !== "note") throw new Error("narrowing");
    expect(first.cursor).not.toBeNull();
    // Same line, so the continuation carries a byte offset beside the line number.
    expect(first.cursor).toMatch(/^l1\.[0-9]+$/);
    expect(first.said).toMatch(/cursor/);
    expect(Buffer.byteLength(first.body, "utf8")).toBeLessThanOrEqual(MEMORY_OPEN_MAX_BYTES);
    // NOT SPLIT MID-CHARACTER: a replacement character is what a byte-offset cut produces.
    expect(first.body).not.toContain("�");

    // ONE LINE, longer than a page: the continuation keeps the SAME line number, because a
    // second number for one line would be an address that addresses nothing.
    expect(first.body.startsWith("     1\t")).toBe(true);

    // The pages CONCATENATE to the stored body — which is the property a cursor has to have
    // and the one a "roughly right" implementation loses. The line prefix is stripped back
    // off, which is the only thing the numbering added.
    const unnumber = (page: string) => page.replace(/^ *\d+\t/, "");
    let assembled = unnumber(first.body);
    let cursor = first.cursor;
    let pages = 1;
    while (cursor) {
      const next = await memoryOpen({ handle: note.handle, cursor, ctx: ctx() });
      if (next.status !== "opened" || next.kind !== "note") throw new Error("narrowing");
      expect(next.body).not.toContain("�");
      expect(next.body.startsWith("     1\t")).toBe(true);
      expect(Buffer.byteLength(next.body, "utf8")).toBeLessThanOrEqual(MEMORY_OPEN_MAX_BYTES);
      assembled += unnumber(next.body);
      cursor = next.cursor;
      pages += 1;
      if (pages > 10) throw new Error("cursor did not terminate");
    }
    expect(pages).toBeGreaterThan(1);
    expect(assembled).toBe(body);
    expect(assembled.endsWith("TAIL")).toBe(true);
  });

  it("pages a multi-line note on LINE boundaries and numbers each page from where it is", async () => {
    const note = await seedNote(PS, "Long note", ["alpha", "beta", "gamma"].join("\n"));
    const first = await memoryOpen({ handle: note.handle, maxBytes: 20, ctx: ctx() });
    if (first.status !== "opened" || first.kind !== "note") throw new Error("narrowing");
    // Two whole lines fit in twenty bytes (7 + 5 + 1 + 7 + 4 = 24 is too many, so one does).
    expect(first.body).toBe("     1\talpha");
    expect(first.cursor).toBe("l2");
    expect(first.said).toContain("lines 1-1 of 3");

    const second = await memoryOpen({ handle: note.handle, cursor: first.cursor!, maxBytes: 20, ctx: ctx() });
    if (second.status !== "opened" || second.kind !== "note") throw new Error("narrowing");
    expect(second.body).toBe("     2\tbeta");
    expect(second.said).toContain("lines 2-2 of 3");
  });

  it("a fabricated cursor is refused rather than repaired", async () => {
    const body = MULTIBYTE.repeat(10);
    const note = await seedNote(PS, "Long note", body);
    // A BARE NUMBER IS NOT A CURSOR, and that is the point of the prefix: without it a
    // fabricated cursor that happens to be a valid line index cannot be told from one this
    // tool handed out, and the reader silently answers from wherever the model chose.
    expect((await memoryOpen({ handle: note.handle, cursor: "1", ctx: ctx() })).status).toBe("bad_cursor");
    // One line, so a cursor naming a second one addresses a line the note does not have —
    // and `l0` names a line no display ever shows.
    expect((await memoryOpen({ handle: note.handle, cursor: "l2", ctx: ctx() })).status).toBe("bad_cursor");
    expect((await memoryOpen({ handle: note.handle, cursor: "l0", ctx: ctx() })).status).toBe("bad_cursor");
    expect((await memoryOpen({ handle: note.handle, cursor: "l999999", ctx: ctx() })).status).toBe("bad_cursor");
    expect((await memoryOpen({ handle: note.handle, cursor: "nope", ctx: ctx() })).status).toBe("bad_cursor");
    // Mid-sequence: byte 1 of the leading two-byte character of line 1. A reader that
    // snapped it forward would hand back a page starting one character late.
    expect((await memoryOpen({ handle: note.handle, cursor: "l1.1", ctx: ctx() })).status).toBe("bad_cursor");
    // The control: byte 2 IS a boundary and line 1 exists, so the refusals above are about
    // these cursors and not about cursors in general.
    expect((await memoryOpen({ handle: note.handle, cursor: "l1.2", ctx: ctx() })).status).toBe("opened");
    expect((await memoryOpen({ handle: note.handle, cursor: "l1", ctx: ctx() })).status).toBe("opened");
  });

  it("stamps last_used_at INSIDE the mint, not from here (M1)", async () => {
    const claim = await seedClaim(PS, "Acme invoices are paid monthly");
    const note = await seedNote(PS, "Deadlines", "body");
    expect(await lastUsedAt("vault_claims", claim.id)).toBeNull();
    expect(await lastUsedAt("vault_notes", note.id)).toBeNull();

    await memoryOpen({ handle: claim.handle, ctx: ctx() });
    await memoryOpen({ handle: note.handle, ctx: ctx() });
    expect(await lastUsedAt("vault_claims", claim.id)).not.toBeNull();
    // On the note IDENTITY, not the version: "when was this read" is a question about the
    // note, and fragmenting it across a history answers a different one.
    expect(await lastUsedAt("vault_notes", note.id)).not.toBeNull();

    // A REFUSED open stamps nothing — the stamp means "the model received this row".
    const untrusted = await seedNote(PS, "What the vendor PDF says", UNTRUSTED_BODY_TEXT, "untrusted_derived");
    await memoryOpen({ handle: untrusted.handle, ctx: ctx() });
    expect(await lastUsedAt("vault_notes", untrusted.id)).toBeNull();
  });

  it("a sensitive row is not found rather than off-channel", async () => {
    // `owner_only` reaches no model channel at all, and `countWithheld` is the only thing
    // that may say how many exist: a per-handle "that one is withheld" would confirm the
    // category the withholding protects.
    const secret = await seedClaim(PS, "The deploy token is ghp16CkQ2fVbNq8sPzYw3TmXrLdA5eHjU9Ki", "user_direct");
    const r = await memoryOpen({ handle: secret.handle, ctx: ctx() });
    expect(r.status).toBe("not_found");
    expect(JSON.stringify(r)).not.toContain("ghp16");
  });

  it("a handle from another user's space, a forgotten row and a fabricated handle are all nothing", async () => {
    // A REAL row in a REAL third space, not an invented address — which is the difference
    // between testing the tool's space fence and testing the mint's `WHERE space_id = $1`.
    // The mint is scoped to the space it is GIVEN, so this handle would open a stranger's
    // fact if the tool did not bound the space first; a fabricated nodeId would have been
    // refused by the mint's own query and the case would have passed with the fence gone.
    const OTHER = `${P}space-someone-else`;
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'user',$2,$2)`, [OTHER, `${P}u2`]);
    const theirs = await seedClaim(OTHER, "zzqq-someone-elses-fact-zzqq", "user_direct");
    const r = await memoryOpen({ handle: theirs.handle, ctx: ctx() });
    expect(r.status).toBe("not_found");
    expect(JSON.stringify(r)).not.toContain("zzqq-someone-elses-fact-zzqq");

    const claim = await seedClaim(PS, "The office moved to Lviv");
    await q(`UPDATE vault_claims SET superseded_at = now() WHERE id = $1`, [claim.id]);
    expect((await memoryOpen({ handle: claim.handle, ctx: ctx() })).status).toBe("not_found");

    expect((await memoryOpen({ handle: "m99", ctx: ctx() })).status).toBe("not_found");
  });

  it("a stored token whose edge never existed renders as text and leaks no id", async () => {
    const note = await seedNote(PS, "Deadlines", `see ${edgeToken("zzqqfabricated")}`);
    const r = await memoryOpen({ handle: note.handle, ctx: ctx() });
    if (r.status !== "opened" || r.kind !== "note") throw new Error("narrowing");
    expect(r.body).toBe("     1\tsee [[link removed]]");
    expect(r.body).not.toContain("zzqqfabricated");
  });
});

run("memory_open fixtures", () => {
  it("leaves no prefixed rows behind", async () => {
    await db.transaction(async () => {});
    const { rows } = await q(`SELECT count(*) AS c FROM spaces WHERE id LIKE $1`, [`${P}%`]);
    expect(Number(rows[0].c)).toBe(0);
  });
});
