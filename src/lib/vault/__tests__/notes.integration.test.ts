import { describe, it, expect, afterEach } from "vitest";
/** Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... node_modules/.bin/vitest run <this file> */
import { db, pool } from "@/lib/db";
import { classify, ownerAuthored } from "../grounding";
import { listMemoryToolRows } from "../model-view";
import { createNote, fitNoteTitle, noteHead, reviseNote, NOTE_TITLE_MAX_CHARS } from "../notes";
import { resolveTopic } from "../topics";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const P = "notestest-";
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

/** A fresh space per test, prefixed and swept to zero. */
let seq = 0;
const seed = async () => {
  const id = `${P}s${++seq}`;
  await q(`INSERT INTO spaces (id,type,ref_id,owner_user_id) VALUES ($1,'user',$2,$2)`, [id, `${P}u${seq}`]);
  return id;
};

const agentClass = () =>
  classify({ kind: "agent_inference" }, { statement: "x", userTurnText: "", untrustedIngressSeen: false }).sourceClass;

run("note versions", () => {
  afterEach(async () => { await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]); });

  it("createNote writes node + note + version 1 + projection in one transaction", async () => {
    const s = await seed();
    const n = await createNote({
      spaceId: s, title: "Reporting", bodyMarkdown: "b", sourceClass: ownerAuthored(),
      provenance: { kind: "test" },
    }, db);
    expect(n.revision).toBe(1);
    expect((await q(`SELECT kind FROM vault_nodes WHERE id=$1`, [n.id])).rows[0].kind).toBe("note");
    expect((await q(`SELECT count(*)::int AS n FROM vault_search_documents WHERE node_id=$1`, [n.id])).rows[0].n).toBe(1);
    expect((await q(`SELECT current_version_id FROM vault_notes WHERE id=$1`, [n.id])).rows[0].current_version_id)
      .toBe(n.versionId);
  });

  it("reviseNote is a CAS on current_revision — a lost CAS writes nothing", async () => {
    const s = await seed();
    const n = await createNote({ spaceId: s, title: "T", bodyMarkdown: "one", sourceClass: ownerAuthored(), provenance: {} }, db);
    const ok = await reviseNote({ noteId: n.id, spaceId: s, expectedRevision: 1, title: "T", bodyMarkdown: "two", sourceClass: ownerAuthored(), provenance: {} }, db);
    expect(ok).toMatchObject({ ok: true, revision: 2 });
    const lost = await reviseNote({ noteId: n.id, spaceId: s, expectedRevision: 1, title: "T", bodyMarkdown: "three", sourceClass: ownerAuthored(), provenance: {} }, db);
    expect(lost).toMatchObject({ ok: false, currentRevision: 2 });
    expect((await q(`SELECT count(*)::int AS n FROM vault_note_versions WHERE note_id=$1`, [n.id])).rows[0].n).toBe(2);
    // The lost CAS wrote NOTHING, not merely no version: the body it carried must not be
    // on the compatibility column either.
    expect((await q(`SELECT body FROM vault_notes WHERE id=$1`, [n.id])).rows[0].body).toBe("two");
  });

  it("a new revision re-arms the horizon from ITS OWN class, never the old one", async () => {
    const s = await seed();
    const n = await createNote({ spaceId: s, title: "T", bodyMarkdown: "b", sourceClass: ownerAuthored(), provenance: {} }, db);
    expect((await q(`SELECT expires_at FROM vault_notes WHERE id=$1`, [n.id])).rows[0].expires_at).toBeNull();
    await reviseNote({ noteId: n.id, spaceId: s, expectedRevision: 1, title: "T", bodyMarkdown: "b2",
      sourceClass: agentClass(), provenance: {} }, db);
    expect((await q(`SELECT expires_at FROM vault_notes WHERE id=$1`, [n.id])).rows[0].expires_at).not.toBeNull();
    // And back the other way, which is the half "re-arms" means and "inherits" would not:
    // an owner rewrite of agent content clears the horizon rather than keeping it.
    await reviseNote({ noteId: n.id, spaceId: s, expectedRevision: 2, title: "T", bodyMarkdown: "b3",
      sourceClass: ownerAuthored(), provenance: {} }, db);
    expect((await q(`SELECT expires_at FROM vault_notes WHERE id=$1`, [n.id])).rows[0].expires_at).toBeNull();
  });

  it("points current_version_id at a version that EXISTS at every moment", async () => {
    // Ruling 17 / review HIGH-2, asserted rather than trusted. The FK is a plain
    // `references()`, not DEFERRABLE, so an UPDATE that names a version before its INSERT
    // raises 23503 on every single revision — the shape the first draft of this plan had.
    // A green revision here IS the assertion; the explicit orphan check is what makes the
    // three-statement order visible to a reader who reorders it later.
    const s = await seed();
    const n = await createNote({ spaceId: s, title: "T", bodyMarkdown: "one", sourceClass: ownerAuthored(), provenance: {} }, db);
    const r = await reviseNote({ noteId: n.id, spaceId: s, expectedRevision: 1, title: "T", bodyMarkdown: "two", sourceClass: ownerAuthored(), provenance: {} }, db);
    expect(r).toMatchObject({ ok: true, revision: 2 });
    const dangling = await q(
      `SELECT count(*)::int AS n FROM vault_notes n
        WHERE n.current_version_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM vault_note_versions v WHERE v.id = n.current_version_id)`);
    expect(dangling.rows[0].n).toBe(0);
  });

  it("the projection follows the HEAD version, not vault_notes.body", async () => {
    const s = await seed();
    const n = await createNote({ spaceId: s, title: "T", bodyMarkdown: "alpha", sourceClass: ownerAuthored(), provenance: {} }, db);
    await reviseNote({ noteId: n.id, spaceId: s, expectedRevision: 1, title: "T", bodyMarkdown: "omega", sourceClass: ownerAuthored(), provenance: {} }, db);
    const row = (await q(`SELECT owner_text, model_text FROM vault_search_documents WHERE node_id=$1`, [n.id])).rows[0];
    expect(row.owner_text).toContain("omega");
    expect(row.owner_text).not.toContain("alpha");
  });

  it("a sensitive head version drops the note out of every model mint", async () => {
    const s = await seed();
    const n = await createNote({ spaceId: s, title: "T", bodyMarkdown: "b", sourceClass: ownerAuthored(), sensitive: true, provenance: {} }, db);
    const { rows } = await listMemoryToolRows([s], { queries: ["T"] });
    expect(rows.find((r) => r.id === n.id)).toBeUndefined();
    expect((await q(`SELECT model_text FROM vault_search_documents WHERE node_id=$1`, [n.id])).rows[0].model_text).toBeNull();
  });

  it("head-ness is revision = current_revision, NOT the id pointer", async () => {
    // The predicate must survive a NULL pointer: NEW-7's whole point.
    const s = await seed();
    const n = await createNote({ spaceId: s, title: "Findable", bodyMarkdown: "b", sourceClass: ownerAuthored(), provenance: {} }, db);
    await q(`UPDATE vault_notes SET current_version_id = NULL WHERE id = $1`, [n.id]);
    const { rows } = await listMemoryToolRows([s], { queries: ["Findable"] });
    expect(rows.some((r) => r.id === n.id)).toBe(true);
    await q(`UPDATE vault_notes SET current_version_id = $2 WHERE id = $1`, [n.id, n.versionId]);
  });

  it("returns a note row the memory tool can address, not a claim row", async () => {
    // The union's note arm, end to end: the mint has to hand back the discriminant and the
    // head version's class, because the formatter switches on the first and T12's channel
    // check reads the second.
    const s = await seed();
    const n = await createNote({ spaceId: s, title: "Quarterly reporting", bodyMarkdown: "the deadline is Friday",
      sourceClass: ownerAuthored(), provenance: {} }, db);
    const { rows } = await listMemoryToolRows([s], { queries: ["reporting"] });
    const hit = rows.find((r) => r.id === n.id);
    expect(hit).toMatchObject({ kind: "note", revision: 1, sourceClass: "owner_authored", spaceId: s });
    if (hit?.kind !== "note") throw new Error("expected a note row");
    expect(String(hit.title)).toBe("Quarterly reporting");
    expect(String(hit.excerpt)).toContain("Friday");
    // A plain note has no containing topic in this slice, and the mint says so rather than
    // inventing one.
    expect(hit.topic).toBeNull();
    // The mint owns the read stamp for notes as well as for claims.
    expect((await q(`SELECT last_used_at FROM vault_notes WHERE id=$1`, [n.id])).rows[0].last_used_at).not.toBeNull();
  });

  it("an agent-written note reaches memory_search and not the manifest tier", async () => {
    const s = await seed();
    const n = await createNote({ spaceId: s, title: "Vendor onboarding", bodyMarkdown: "b",
      sourceClass: agentClass(), provenance: {} }, db);
    expect((await q(`SELECT prompt_access FROM vault_note_versions WHERE note_id=$1`, [n.id])).rows[0].prompt_access)
      .toBe("memory_search");
    const { rows } = await listMemoryToolRows([s], { queries: ["onboarding"] });
    expect(rows.some((r) => r.id === n.id)).toBe(true);
  });

  it("the secret screen raises sensitive on a body the caller called safe", async () => {
    const s = await seed();
    const n = await createNote({ spaceId: s, title: "Keys", bodyMarkdown: "sk-live-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sourceClass: ownerAuthored(), provenance: {} }, db);
    expect(n.sensitive).toBe(true);
    expect((await q(`SELECT prompt_access FROM vault_note_versions WHERE note_id=$1`, [n.id])).rows[0].prompt_access)
      .toBe("owner_only");
  });

  it("noteHead reads the head version and refuses a space the caller may not read", async () => {
    const s = await seed();
    const other = await seed();
    const n = await createNote({ spaceId: s, title: "T", bodyMarkdown: "one", sourceClass: ownerAuthored(), provenance: {} }, db);
    await reviseNote({ noteId: n.id, spaceId: s, expectedRevision: 1, title: "T2", bodyMarkdown: "two", sourceClass: ownerAuthored(), provenance: {} }, db);
    const head = await noteHead(n.id, [s]);
    expect(head).toMatchObject({ revision: 2, title: "T2", bodyMarkdown: "two", promptAccess: "manifest" });
    expect(await noteHead(n.id, [other])).toBeNull();
    expect(await noteHead(n.id, [])).toBeNull();
  });

  it("EVERY note-creating path mints a revision 1 — there are two, and this is the other", async () => {
    // MED-2 from Task 2's review. `0065`'s backfill is one-shot, so a note created without
    // a version after it ran can never be re-checked; the property has to hold at the
    // writers. `createNote` above is one entrance and `resolveTopic` is the other.
    const s = await seed();
    const t = await resolveTopic(s, "Reporting", db);
    const { rows } = await q(
      `SELECT v.revision, v.title, v.source_class FROM vault_note_versions v WHERE v.note_id = $1`, [t.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revision: 1, title: "Reporting", source_class: "owner_authored" });
    const [note] = (await q(`SELECT current_version_id, current_revision FROM vault_notes WHERE id=$1`, [t.id])).rows;
    expect(note.current_version_id).not.toBeNull();
    expect(note.current_revision).toBe(1);
  });

  it("refuses to write a note into a retired space, on both writers", async () => {
    const s = await seed();
    const n = await createNote({ spaceId: s, title: "T", bodyMarkdown: "b", sourceClass: ownerAuthored(), provenance: {} }, db);
    await q(`UPDATE spaces SET retired_at = now() WHERE id = $1`, [s]);
    await expect(createNote({ spaceId: s, title: "T2", bodyMarkdown: "b", sourceClass: ownerAuthored(), provenance: {} }, db))
      .rejects.toThrow(/retired/);
    await expect(reviseNote({ noteId: n.id, spaceId: s, expectedRevision: 1, title: "T", bodyMarkdown: "c",
      sourceClass: ownerAuthored(), provenance: {} }, db)).rejects.toThrow(/retired/);
  });

  it("clamps a note title to one line of NOTE_TITLE_MAX_CHARS", () => {
    expect(fitNoteTitle("  a\n b  ")).toBe("a b");
    expect(fitNoteTitle("x".repeat(400))).toHaveLength(NOTE_TITLE_MAX_CHARS);
  });
});
