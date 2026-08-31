import { describe, it, expect, afterEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 */
import { db, pool } from "@/lib/db";
import { deleteNode } from "../nodes";
import { resolveTopic, getOrCreateTopicNote, topicTitleNorm, DEFAULT_TOPIC_KEY } from "../topics";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const P = "toptest-";
const q = (t: string, p: unknown[] = []) => pool.query(t, p);

run("resolveTopic", () => {
  const seed = async () => {
    await q(`INSERT INTO spaces (id,type,ref_id,owner_user_id) VALUES ($1,'user',$2,$2)`, [`${P}s`, `${P}u`]);
    return `${P}s`;
  };
  afterEach(async () => {
    await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
  });

  it("folds two spellings of one title onto one topic", async () => {
    const s = await seed();
    const a = await resolveTopic(s, "Work Notes", db);
    const b = await resolveTopic(s, "  work   notes ", db);
    expect(b.id).toBe(a.id);
    expect(a.state).toBe("created");
    expect(b.state).toBe("existing");
  });

  it("REVIVES a soft-deleted topic rather than building a parallel one beside it", async () => {
    const s = await seed();
    const a = await resolveTopic(s, "Suppliers", db);
    await deleteNode(a.id, s, db);
    const b = await resolveTopic(s, "suppliers", db);
    expect(b.id).toBe(a.id);
    expect(b.state).toBe("revived");
    expect((await q(`SELECT deleted_at FROM vault_nodes WHERE id=$1`, [a.id])).rows[0].deleted_at).toBeNull();
  });

  it("sends a secret-shaped title to the default topic and says so", async () => {
    const s = await seed();
    const r = await resolveTopic(s, "ghp16CkQ2fVbNq8sPzYw3TmXrLdA5eHjU9Ki", db);
    expect(r.state).toBe("secret_fallback");
    expect((await q(`SELECT topic_key FROM vault_notes WHERE id=$1`, [r.id])).rows[0].topic_key)
      .toBe(DEFAULT_TOPIC_KEY);
  });

  it("takes a run-local handle that resolves to a live topic in THIS space", async () => {
    const s = await seed();
    const a = await resolveTopic(s, "Reporting", db);
    const r = await resolveTopic(s, "n1", db, {
      resolveHandle: (h) => (h === "n1" ? { spaceId: s, nodeId: a.id, kind: "n" } : null),
    });
    expect(r.id).toBe(a.id);
    expect(r.state).toBe("existing");
  });

  it("treats a handle from ANOTHER space as words, never as a cross-space attach", async () => {
    const s = await seed();
    const r = await resolveTopic(s, "n9", db, {
      resolveHandle: () => ({ spaceId: "some-other-space", nodeId: "x", kind: "n" }),
    });
    expect(r.state).toBe("created");
    expect(r.title).toBe("n9");
  });

  it("blank goes to the default topic", async () => {
    const s = await seed();
    expect((await resolveTopic(s, "   ", db)).state).toBe("default");
    expect((await resolveTopic(s, undefined, db)).state).toBe("default");
  });

  it("clamps a long title to TOPIC_TITLE_MAX_CHARS", async () => {
    const s = await seed();
    // WORDS, not one long run, and `model-view.integration.test.ts` found this first:
    // `looksLikeSecret` screens an unbroken 28+ character run, so `"x".repeat(200)` is
    // taken by the secret screen (arm 6) and returned as the DEFAULT topic - a 7-character
    // "General" that never reaches the clamp at all. The assertion would then be about the
    // wrong arm while still reading like a clamp test.
    const long = "quarterly reporting ".repeat(12);
    const r = await resolveTopic(s, long, db);
    expect(r.state).toBe("created");
    expect(r.title.length).toBe(64);
  });

  it("refuses a retired space", async () => {
    const s = await seed();
    await q(`UPDATE spaces SET retired_at = now() WHERE id = $1`, [s]);
    await expect(resolveTopic(s, "Anything", db)).rejects.toThrow(/retired/);
  });

  it("the SQL index and topicTitleNorm agree — a raw insert of a folded title gets 23505", async () => {
    const s = await seed();
    await resolveTopic(s, "Reporting FOP", db);
    await expect(q(
      `INSERT INTO vault_notes (id, space_id, title, kind, current_revision)
       VALUES ($1,$2,'  reporting   fop ','memory_topic',1)`, [`${P}dup`, s],
    )).rejects.toMatchObject({ code: "23505", constraint: "uniq_vnotes_topic_title" });
  });

  it("agrees with SQL OFF the ASCII path, on BOTH of the twin's operations", async () => {
    // MED-11 and NEW-5, asserted rather than reasoned about. The twin has two operations
    // and each diverges from SQL on its own if written with the reflexive JS idiom:
    //   collapse - JS `\s` matches U+00A0, Postgres `[[:space:]]` does not
    //   trim     - JS `.trim()` strips U+00A0, `btrim(x)` strips ASCII spaces only
    // Either one folds a title the index considers distinct, which is a silent duplicate
    // topic under the one constraint built to make duplicates impossible. Three inputs,
    // one per way it breaks, plus the plain interior-run case. Written as escapes so this
    // FILE stays ASCII while the runtime strings are not.
    const sqlSide = async (t: string) => (await q(
      `SELECT lower(btrim(regexp_replace($1::text, '[[:space:]]+', ' ', 'g'))) AS n`, [t],
    )).rows[0].n as string;
    for (const input of [
      "  Acme  Ltd  ",                 // interior ASCII runs + ASCII trim
      "\u00a0Acme Ltd\u00a0",          // LEADING/TRAILING NBSP - the trim half (NEW-5)
      "Acme\u00a0Ltd",                 // interior NBSP - the collapse half (MED-11)
    ]) {
      expect(await sqlSide(input)).toBe(topicTitleNorm(input));
    }
  });

  it("is UNREACHABLE through resolveTopic, because fitTopicTitle runs first", async () => {
    // The other half of NEW-5, and it is why the ASCII class downstream is SUFFICIENT
    // rather than merely narrower. `fitTopicTitle` keeps JS `\s` deliberately: it runs on
    // what a person typed, before either half of the twin, and turns a pasted NBSP into an
    // ordinary space. So a person cannot create the divergent pair through the resolver -
    // the two titles fold to one topic, which is the behavior they wanted anyway.
    //
    // Asserted rather than trusted, because it is the sentence `topicTitleNorm`'s docstring
    // rests on: if `fitTopicTitle` ever stops running first, this goes red BEFORE a
    // duplicate topic appears on someone's memory page.
    const s = await seed();
    const a = await resolveTopic(s, "Acme Ltd", db);
    const b = await resolveTopic(s, "Acme\u00a0Ltd", db);
    expect(b.id).toBe(a.id);
    expect(b.state).toBe("existing");
  });

  it("resolves a title whose CASE-fold JS and SQL disagree on, twice, onto one topic", async () => {
    // Review HIGH-1, and the third operation of the twin. `lower()` follows the database's
    // collation and `toLowerCase()` follows Unicode default casing, and they disagree:
    //   U+0130 (dotted capital I) -> "i" in Postgres, "i" + U+0307 in JS
    //   a word-final capital sigma -> U+03C3 in Postgres, final sigma U+03C2 in JS
    // Unlike whitespace this has NO pre-normalizer - `fitTopicTitle` does not case-fold -
    // so a JS-computed lookup missed a row the index then refused, and the re-read missed
    // it again: `topic "..." vanished after insert`, thrown on the hot path of a turn. That
    // is H5 reached through the case door.
    //
    // Asserted as an OUTCOME rather than as `JS == SQL`, because they are not equal and no
    // longer have to be: the fold is computed in SQL on both sides, and the 23505 catch
    // behind it degrades any residual disagreement to reuse. Written as escapes so this
    // FILE stays ASCII while the runtime strings are not.
    const s = await seed();
    for (const spelling of ["\u0130stanbul", "\u03a3\u039f\u03a6\u039f\u03a3"]) {
      const a = await resolveTopic(s, spelling, db);
      const b = await resolveTopic(s, spelling, db);
      expect(a.state).toBe("created");
      expect(b.state).toBe("existing");
      expect(b.id).toBe(a.id);
    }
    const n = await q(`SELECT count(*)::int AS n FROM vault_notes WHERE space_id = $1`, [s]);
    expect(n.rows[0].n).toBe(2);
  });

  it("loses the insert race under a SAVEPOINT: one topic, one creator, no orphan node", async () => {
    // The 23505 arm, reached the way it is actually reached - three concurrent resolvers,
    // each in its own transaction, none of which can see the others' uncommitted row at
    // the fold. Two of them insert, collide, and roll back TO THE SAVEPOINT, which takes
    // their node row with the note attempt; that is what keeps these two counts equal, and
    // under the old `onConflictDoNothing` shape it took an explicit hard node delete.
    const s = await seed();
    const all = await Promise.all([
      resolveTopic(s, "Contracts", db),
      resolveTopic(s, "contracts", db),
      resolveTopic(s, "  CONTRACTS ", db),
    ]);
    expect(new Set(all.map((r) => r.id)).size).toBe(1);
    expect(all.filter((r) => r.state === "created").length).toBe(1);
    const notes = await q(`SELECT count(*)::int AS n FROM vault_notes WHERE space_id = $1`, [s]);
    const nodes = await q(
      `SELECT count(*)::int AS n FROM vault_nodes WHERE space_id = $1 AND kind = 'note'`, [s],
    );
    expect(nodes.rows[0].n).toBe(notes.rows[0].n);
    expect(notes.rows[0].n).toBe(1);
  });

  it("gives a created topic its revision 1 and the pointer to it", async () => {
    // LOW-5. `resolveTopic` is a note writer, so `0065`'s one-shot backfill can never
    // re-check what it creates: a topic minted without a version would be invisible to
    // every note-reading mint and there would be no second pass to notice.
    const s = await seed();
    const a = await resolveTopic(s, "Logistics", db);
    const [row] = (await q(
      `SELECT n.current_revision, v.revision, v.title, v.source_class, v.provenance
         FROM vault_notes n JOIN vault_note_versions v ON v.id = n.current_version_id
        WHERE n.id = $1`, [a.id],
    )).rows;
    expect(row.current_revision).toBe(1);
    expect(row.revision).toBe(1);
    expect(row.title).toBe("Logistics");
    expect(row.source_class).toBe("owner_authored");
    expect(row.provenance).toEqual({ kind: "topic_created" });
  });

  it("treats a handle whose target is soft-deleted, or is not a note, as words", async () => {
    // LOW-6, the two fall-through branches of the handle arm that nothing else reaches.
    // Both are the arm working, not a gap in it: an unresolvable handle is never an error
    // the model has to handle, and never an attach to something it did not name.
    const s = await seed();
    const gone = await resolveTopic(s, "Archived", db);
    await deleteNode(gone.id, s, db);
    const dead = await resolveTopic(s, "n1", db, {
      resolveHandle: () => ({ spaceId: s, nodeId: gone.id, kind: "n" }),
    });
    expect(dead.state).toBe("created");
    expect(dead.title).toBe("n1");

    const live = await resolveTopic(s, "Invoices", db);
    const wrongKind = await resolveTopic(s, "m2", db, {
      resolveHandle: () => ({ spaceId: s, nodeId: live.id, kind: "m" }),
    });
    expect(wrongKind.state).toBe("created");
    expect(wrongKind.title).toBe("m2");
    expect(wrongKind.id).not.toBe(live.id);
  });

  it("getOrCreateTopicNote survives a label colliding with a resolver-minted title (H5)", async () => {
    const s = await seed();
    await resolveTopic(s, "General", db);            // normalized title == TOPIC_LABELS.general
    const id = await getOrCreateTopicNote(s, DEFAULT_TOPIC_KEY, db);
    expect(typeof id).toBe("string");                // it used to throw "vanished after insert"
  });
});
