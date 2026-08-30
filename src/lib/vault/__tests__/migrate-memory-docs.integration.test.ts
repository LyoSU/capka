import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * Migrating legacy memory_docs into the REVIEW QUEUE. Nothing but `proposeCandidate`
 * is mocked: the whole point of this module is the CAS on the document row and which
 * rows Postgres rolls back along with `migrated_at` when something fails mid-document.
 * An in-memory double would be testing its own imagination.
 *
 * WHAT CHANGED, because most of this suite used to assert the opposite: bullets became
 * CONFIRMED CLAIMS, written straight through `createClaim` with `reviewStatus:
 * "confirmed"`. That is a writer declaring its own output approved — unattended, at
 * boot, on free text that both the user and the agent wrote into and nobody reviewed.
 * They become pending candidates now, and the person keeps their own facts once.
 *
 * EVERY call passes `docIds`. Without it `migrateMemoryDocs()` by construction takes
 * EVERY unmigrated document in the database — and this database is shared, holding
 * a developer's real memory: the suite would migrate it and leave behind a space,
 * candidates and a set `migrated_at` that no prefix-scoped DELETE cleans up.
 * The assertions are scoped too (`space_id = $1`, prefixed ids) — the worker lives
 * next door.
 */
import { inspect } from "node:util";
import { pool } from "@/lib/db";
import { getOrCreateSpace, retireProjectSpace } from "../spaces";
import { migrateMemoryDocs } from "../migrate-memory-docs";
import { buildMemoryManifest } from "../manifest";
import { seedConfirmedClaim } from "./fixtures";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** A "mid-document" failure is keyed on the bullet's TEXT, not on a call ordinal:
 *  the order of documents in the selection is undefined, so "the third call" is not
 *  a variable we control, while "the third bullet of THIS document" is. */
const hook = vi.hoisted(() => ({ failOn: null as string | null }));

vi.mock("../candidates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../candidates")>();
  return {
    ...actual,
    proposeCandidate: (...args: Parameters<typeof actual.proposeCandidate>) => {
      if (hook.failOn && args[0].statement === hook.failOn) {
        // Shaped like what the installed Drizzle actually throws: the failing
        // statement's PARAMETERS are embedded in the message, and the driver's own
        // error hangs off `cause`. That is the whole hazard behind the log assertion
        // below — the secret is genuinely inside this object.
        const e = new Error(
          `Failed query: insert into "memory_candidates" ... params: ${hook.failOn}`,
        ) as Error & { cause: unknown };
        e.cause = { code: "23503", constraint: "mcand_space_fk" };
        throw e;
      }
      return actual.proposeCandidate(...args);
    },
  };
});

/** Captures what the module hands the logger. Asserting on the ARGUMENTS rather than
 *  on stdout is the point: the question is what this module chose to pass on, not how
 *  the sink happened to render it. */
const logged = vi.hoisted(() => ({ errors: [] as { msg: string; ctx?: Record<string, unknown> }[] }));
vi.mock("@/lib/log", () => ({
  log: {
    error: (msg: string, ctx?: Record<string, unknown>) => logged.errors.push({ msg, ctx }),
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
  },
}));

/** Every fixture id carries this prefix. Space ids are not ours to choose (nanoid,
 *  from the inside), so those are caught by owner_user_id instead. */
const P = "mdmig-";
const OWNER = `${P}owner`;
const PROJ = `${P}proj`;

/** Migrate only the named documents — see the note at the top of the suite. */
const migrate = (...docIds: string[]) => migrateMemoryDocs({ docIds });

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

/** The node half of a subtype row. Raw fixtures write the subtype row directly, so they
 *  own the node row too — the composite FK is what turned "every subtype row has a node"
 *  from a convention into a constraint. */
const seedNode = (id: string, spaceId: string, kind: "claim" | "note" | "source") =>
  q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, spaceId, kind]);

const count = async (table: string, where: string, params: unknown[]) => {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, params);
  return Number(rows[0].n);
};

/** users.email is unique too — a targeted ON CONFLICT (id) would raise 23505 on a
 *  leftover row with the same email, which reads like a skipped test. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'memory doc migration test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

const mkDoc = (id: string, content: string, projectId: string | null = null) =>
  q(`INSERT INTO memory_docs (id, user_id, project_id, content) VALUES ($1, $2, $3, $4)`, [
    id,
    OWNER,
    projectId,
    content,
  ]);

const spaceOf = async (type: "user" | "project", refId: string): Promise<string | null> => {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM spaces WHERE type = $1 AND ref_id = $2`, [
    type,
    refId,
  ]);
  return rows[0]?.id ?? null;
};

/** What a migration produces now: rows in the review queue. Unresolved only — a
 *  resolved one is a decision somebody already took. */
const waiting = async (spaceId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ statement: string }>(
    `SELECT statement FROM memory_candidates
      WHERE space_id = $1 AND resolved_at IS NULL AND policy_state = 'pending'`,
    [spaceId],
  );
  return rows.map((r) => r.statement);
};

/** Live claim heads in a space. Used to assert that a migration creates NONE, which is
 *  the whole change: this pass proposes, it does not write memory. */
const statements = async (spaceId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ statement: string }>(
    `SELECT statement FROM vault_claims WHERE space_id = $1 AND superseded_at IS NULL`,
    [spaceId],
  );
  return rows.map((r) => r.statement);
};

const migratedAt = async (docId: string): Promise<Date | null> => {
  const { rows } = await pool.query<{ migrated_at: Date | null }>(
    `SELECT migrated_at FROM memory_docs WHERE id = $1`,
    [docId],
  );
  return rows[0]?.migrated_at ?? null;
};

type MigrationEvent = {
  actor: unknown;
  /** `chars` and `sha256` are typed here although the code no longer writes them —
   *  that is what lets the assertions below say they are ABSENT rather than merely not
   *  looked at. An unsalted digest of a short memory document, retained past the user's
   *  own deletion, is a dictionary oracle for the text the deletion removed. */
  payload: { content?: string; docId?: string; bullets?: number; chars?: number; sha256?: string };
};

const snapshots = async (spaceId: string): Promise<MigrationEvent[]> => {
  const { rows } = await pool.query<MigrationEvent>(
    `SELECT actor, payload FROM audit_events
      WHERE space_id = $1 AND action = 'system.memory_doc_migrated' ORDER BY created_at`,
    [spaceId],
  );
  return rows;
};

const cleanup = async () => {
  await q(`DELETE FROM memory_docs WHERE id LIKE $1`, [`${P}%`]);
  // The space drags claims, topics, attachments and events along with it.
  await q(`DELETE FROM spaces WHERE owner_user_id LIKE $1`, [`${P}%`]);
};

run("vault: memory_docs migration", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await q(`INSERT INTO projects (id, user_id, name) VALUES ($1, $2, 'migration test') ON CONFLICT (id) DO NOTHING`, [
      PROJ,
      OWNER,
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM projects WHERE id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });

  beforeEach(async () => {
    hook.failOn = null;
    logged.errors.length = 0;
    await cleanup();
  });

  it("a credential in a LEGACY document reaches the review queue, flagged — and never the prompt", async () => {
    // The case that made this Critical rather than theoretical. The old memory system
    // screened nothing, so an existing deployment's documents may already hold a pasted
    // key — and this migration runs unattended, at boot, on exactly that data. It used
    // to write `confirmed` claims through `createClaim` directly, so the bullet landed
    // in `recentFacts`, i.e. in the system prompt of every later turn.
    const secret = "sk-proj-AbCdEf0123456789ghijklMnOpQrStUvWxYz";
    await mkDoc(`${P}dsec`, `- my openai key is ${secret}\n- likes tea\n`);

    expect(await migrate(`${P}dsec`)).toEqual({ migrated: 1 });
    const spaceId = (await spaceOf("user", OWNER))!;

    // NOTHING entered memory. Not the credential, and not the harmless bullet beside
    // it: the pass has no authority to approve either.
    expect(await statements(spaceId)).toEqual([]);

    // Both are waiting for the person, and the credential is FLAGGED for them — the
    // screen is advisory now, and this is the surface the advice is for.
    const { rows } = await pool.query<{ statement: string; sensitive: boolean }>(
      `SELECT statement, sensitive FROM memory_candidates WHERE space_id = $1`,
      [spaceId],
    );
    const key = rows.find((r) => r.statement.includes(secret));
    expect(key).toBeDefined();
    expect(key!.sensitive).toBe(true);
    // The ordinary bullet in the same document is untouched, so this is a screen and
    // not a blanket.
    expect(rows.find((r) => r.statement === "likes tea")!.sensitive).toBe(false);

    // The surface that would have carried it, driven for real.
    const manifest = await buildMemoryManifest({ userSpaceId: spaceId });
    expect(manifest).not.toContain(secret);
    expect(manifest).not.toContain("likes tea");
  });

  it("a document's bullets become PENDING candidates — no claim, and an attesting event", async () => {
    const content = "- likes tea\n\n* deadline on Friday\n  - works from Lviv\n";
    await mkDoc(`${P}d1`, content);

    expect(await migrate(`${P}d1`)).toEqual({ migrated: 1 });

    const spaceId = await spaceOf("user", OWNER);
    expect(spaceId).not.toBeNull();
    // The whole change, in one assertion: the document is carried, and memory is empty.
    expect(await statements(spaceId!)).toEqual([]);
    expect(new Set(await waiting(spaceId!))).toEqual(
      new Set(["likes tea", "deadline on Friday", "works from Lviv"]),
    );
    // The origin is what the memory page turns into "this came from your old notes".
    expect(
      await count(
        "memory_candidates",
        "space_id = $1 AND policy_state = 'pending' AND provenance->>'kind' = 'legacy_memory_doc'",
        [spaceId],
      ),
    ).toBe(3);

    // The event ATTESTS to the move; it does not keep a second copy of the text, nor
    // anything derived from it. A full snapshot outlived the user's own deletion of the
    // project (`retireProjectSpace` deliberately preserves the audit trail) — and so did
    // the digest that replaced it, which over short memory text is a dictionary oracle
    // for exactly what the deletion removed.
    const events = await snapshots(spaceId!);
    expect(events).toHaveLength(1);
    expect(events[0].payload.docId).toBe(`${P}d1`);
    expect(events[0].payload.bullets).toBe(3);
    expect(events[0].payload.chars).toBeUndefined();
    expect(events[0].payload.sha256).toBeUndefined();
    expect(events[0].actor).toEqual({ kind: "system" });
    expect(events[0].payload.content).toBeUndefined();
    expect(JSON.stringify(events[0].payload)).not.toContain("likes tea");
    expect(JSON.stringify(events[0].payload)).not.toContain("works from Lviv");

    expect(await migratedAt(`${P}d1`)).not.toBeNull();
  });

  it("a second call adds nothing and does not re-stamp the document", async () => {
    await mkDoc(`${P}d2`, "- one\n- two");
    await migrate(`${P}d2`);

    const spaceId = (await spaceOf("user", OWNER))!;
    const stamp = await migratedAt(`${P}d2`);
    expect(stamp).not.toBeNull();

    expect(await migrate(`${P}d2`)).toEqual({ migrated: 0 });

    expect(await count("memory_candidates", "space_id = $1", [spaceId])).toBe(2);
    expect(await snapshots(spaceId)).toHaveLength(1);
    expect(await migratedAt(`${P}d2`)).toEqual(stamp);
  });

  it("catches a document appended to AFTER its stamp (migrated_at < updated_at), and converges", async () => {
    // The window the cutover closes: boot stamped the document, then a legacy
    // turn-time writer appended to it. Those bullets are carried nowhere by an
    // `IS NULL` selector — the manifest's legacy fallback reads the same column, so
    // they would vanish from the screen with no error at all.
    await mkDoc(`${P}d9`, "- first fact");
    expect(await migrate(`${P}d9`)).toEqual({ migrated: 1 });
    const spaceId = (await spaceOf("user", OWNER))!;

    // Both timestamps are dated into the PAST, stamp first and append after it. The
    // obvious fixture — `updated_at = migrated_at + 1 second` — puts the append in
    // the FUTURE, so the re-stamp lands inside that second and the document selects
    // itself forever; the convergence assertion below is what caught that.
    await q(
      `UPDATE memory_docs
          SET content = $2,
              migrated_at = now() - interval '2 hours',
              updated_at  = now() - interval '1 hour'
        WHERE id = $1`,
      [`${P}d9`, "- first fact\n- added after the stamp"],
    );
    const stamp = await migratedAt(`${P}d9`);

    expect(await migrate(`${P}d9`)).toEqual({ migrated: 1 });
    // COUNT, not a Set: a Set discards duplicates, so wrapping the projection in one
    // silently swallows the very doubling this assertion exists to catch — remove
    // `migrateOne`'s dedup and the Set version stays green.
    expect(await count("memory_candidates", "space_id = $1", [spaceId])).toBe(2);
    expect((await waiting(spaceId)).sort()).toEqual(["added after the stamp", "first fact"]);
    expect(await migratedAt(`${P}d9`)).not.toEqual(stamp);
    // Converges by construction: the fresh stamp is now past `updated_at`, and after
    // the cutover nothing moves `updated_at` again.
    expect(await migrate(`${P}d9`)).toEqual({ migrated: 0 });
  });

  it("a bullet longer than the statement cap is keyed by its clamped text, so it is not re-proposed", async () => {
    // The idempotency key is built from the statement AS STORED (`fitStatement` first),
    // and the row it has to match was written the same way. Keyed on the raw line
    // instead, a bullet over 500 characters would not match its own candidate and a
    // second pass would ask the person about it twice. Reachable only through the
    // append-after-stamp window above, which is why the fixture opens one.
    //
    // Deliberately NOT a long unbroken run of characters: that is secret-shaped, and a
    // sensitive claim would make this test about the screen instead.
    const long = "the supplier grants a thirty day payment deferral on the standing order. ".repeat(9);
    expect(long.length).toBeGreaterThan(500);
    await mkDoc(`${P}d10`, `- ${long}`);
    expect(await migrate(`${P}d10`)).toEqual({ migrated: 1 });
    const spaceId = (await spaceOf("user", OWNER))!;
    expect(await count("memory_candidates", "space_id = $1", [spaceId])).toBe(1);

    await q(
      `UPDATE memory_docs
          SET content = $2,
              migrated_at = now() - interval '2 hours',
              updated_at  = now() - interval '1 hour'
        WHERE id = $1`,
      [`${P}d10`, `- ${long}\n- a short fact added later`],
    );
    expect(await migrate(`${P}d10`)).toEqual({ migrated: 1 });
    // Two rows, not three: the long bullet keyed to the candidate it already had, and
    // only the appended one is new.
    expect(await count("memory_candidates", "space_id = $1", [spaceId])).toBe(2);
    expect((await waiting(spaceId)).length).toBe(2);
  });

  it("a race between two migrations duplicates no row (CAS on the document row)", async () => {
    await mkDoc(`${P}d3`, "- fact A\n- fact B");

    const [a, b] = await Promise.all([migrate(`${P}d3`), migrate(`${P}d3`)]);

    // Exactly one of the two claimed the document — the other saw zero rows on the CAS.
    expect(a.migrated + b.migrated).toBe(1);
    const spaceId = (await spaceOf("user", OWNER))!;
    expect(await waiting(spaceId)).toHaveLength(2);
    expect(await snapshots(spaceId)).toHaveLength(1);
  });

  it("a mid-document failure rolls back EVERYTHING including migrated_at; the next run migrates cleanly", async () => {
    await mkDoc(`${P}d4`, "- one\n- two\n- three\n- four");
    hook.failOn = "three";

    await expect(migrate(`${P}d4`)).rejects.toThrow(`1 memory doc(s) did not migrate: ${P}d4`);

    // The space was created in that same transaction, so its absence IS the proof of
    // a full rollback: no claims, no topic, no event.
    expect(await spaceOf("user", OWNER)).toBeNull();
    expect(await migratedAt(`${P}d4`)).toBeNull();

    hook.failOn = null;
    await migrate(`${P}d4`);

    const spaceId = (await spaceOf("user", OWNER))!;
    expect(new Set(await waiting(spaceId))).toEqual(new Set(["one", "two", "three", "four"]));
    expect(await migratedAt(`${P}d4`)).not.toBeNull();
  });

  it("a failing document does not hide the rest from the migration", async () => {
    await mkDoc(`${P}d8bad`, "- sound\n- poisonous");
    await mkDoc(`${P}d8ok`, "- a neighbouring fact", PROJ);
    hook.failOn = "poisonous";

    // The throw remains — otherwise the retry at boot would not fire — but only after
    // the remaining documents have been migrated. The selection order is undefined,
    // so the healthy document has to arrive whichever of the two went first.
    await expect(migrate(`${P}d8bad`, `${P}d8ok`)).rejects.toThrow(`did not migrate: ${P}d8bad`);

    expect(await migratedAt(`${P}d8ok`)).not.toBeNull();
    expect(await waiting((await spaceOf("project", PROJ))!)).toEqual(["a neighbouring fact"]);

    expect(await migratedAt(`${P}d8bad`)).toBeNull();
    expect(await spaceOf("user", OWNER)).toBeNull();
  });

  it("an empty document is stamped and produces no claims", async () => {
    await mkDoc(`${P}d5`, "");

    await migrate(`${P}d5`);

    expect(await migratedAt(`${P}d5`)).not.toBeNull();
    const spaceId = (await spaceOf("user", OWNER))!;
    expect(await count("memory_candidates", "space_id = $1", [spaceId])).toBe(0);
    const events = await snapshots(spaceId);
    expect(events).toHaveLength(1);
    expect(events[0].payload.bullets).toBe(0);
    expect(events[0].payload.chars).toBeUndefined();
    expect(events[0].payload.sha256).toBeUndefined();
  });

  it("a bullet the person has already confirmed is not proposed again", async () => {
    // Dedup, and it now lives in ONE place — `proposeCandidate`, reading the same
    // model-facing projection the manifest reads. A legacy bullet the person has
    // already kept must not come back as a question.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await seedConfirmedClaim(
      { spaceId, statement: "Likes   tea", origin: { kind: "legacy_memory_doc" }, sourceClass: "agent_inferred" },
      { kind: "user", id: OWNER },
    );
    await mkDoc(`${P}d6`, "- likes tea\n- something new");

    await migrate(`${P}d6`);

    // The same normalization as in the ledger: case and repeated spaces do not turn one
    // fact into two, so only the genuinely new bullet is asked about.
    expect(await waiting(spaceId)).toEqual(["something new"]);
    // And nothing was written to the confirmed fact either — no evidence, no second
    // version. A dedup that "tops up" the fact it matched is a durable write on the
    // strength of unreviewed text, which is the whole class this round closes.
    expect(await count("vault_claims", "space_id = $1", [spaceId])).toBe(1);
  });

  it("a bullet matching an UNVERIFIED head is asked about — matching one does not approve it", async () => {
    // The old behaviour, and it was quarantine escalation with a friendly face: a bullet
    // whose words matched an unverified head called `confirmClaim` on it, so text nobody
    // had reviewed promoted text nobody had reviewed. An unverified head is not in the
    // model-facing projection, so the dedup cannot see it and the bullet becomes an
    // ordinary question for the person.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await seedNode(`${P}unverified`, spaceId, "claim");
    await q(
      `INSERT INTO vault_claims (id, space_id, statement, origin, review_status, sensitive, source_class)
       VALUES ($1, $2, 'Likes tea', '{"kind":"derived"}'::jsonb, 'unverified', false, 'agent_inferred')`,
      [`${P}unverified`, spaceId],
    );
    await mkDoc(`${P}d9b`, "- likes tea");

    await migrate(`${P}d9b`);

    expect(await count("vault_claims", "space_id = $1 AND review_status = 'confirmed'", [spaceId])).toBe(0);
    expect(await count("vault_claims", "id = $1 AND review_status = 'unverified'", [`${P}unverified`])).toBe(1);
    expect(await waiting(spaceId)).toEqual(["likes tea"]);
  });

  it("the candidates land in the document's TRANSACTION, so a failure takes them with it", async () => {
    // A candidate written through the module-level `db` instead of the document's `tx`
    // would commit on its own and survive the rollback — atomicity lost in a way no
    // after-the-fact assertion can see, because every other check here reads the
    // database once the transaction is already gone. The bullet order matters: the
    // first is written BEFORE the second blows up.
    await mkDoc(`${P}d10b`, "- likes tea\n- poisonous");
    hook.failOn = "poisonous";

    await expect(migrate(`${P}d10b`)).rejects.toThrow(`did not migrate: ${P}d10b`);

    // The space was created in the same transaction, so its absence is the proof.
    expect(await spaceOf("user", OWNER)).toBeNull();
    expect(await migratedAt(`${P}d10b`)).toBeNull();
  });

  it("a project's document lands in the project space, owned by the document's owner", async () => {
    await mkDoc(`${P}d7`, "- a project fact", PROJ);

    await migrate(`${P}d7`);

    const spaceId = await spaceOf("project", PROJ);
    expect(spaceId).not.toBeNull();
    expect(await count("spaces", "id = $1 AND owner_user_id = $2", [spaceId, OWNER])).toBe(1);
    expect(await waiting(spaceId!)).toEqual(["a project fact"]);
  });

  it("a document whose project was deleted first cannot CREATE a live space to land in", async () => {
    // The entrance the lifecycle fence does not cover. `retireProjectSpace` used to be
    // a no-op when the space row did not exist yet — a project that predates the vault,
    // or one whose memory was off — so teardown left nothing behind for anyone to read.
    // This migration then ran at boot, CREATED the space itself (live, by definition),
    // passed its own fence against the row it had just written, and committed a deleted
    // project's memory into a space no re-drive can find: no project row is left to
    // teardown again, so it survives until the account is deleted.
    const gone = `${P}gone-proj`;
    await q(
      `INSERT INTO projects (id, user_id, name, deleted_at) VALUES ($1, $2, 'deleted mid-boot', now())`,
      [gone, OWNER],
    );
    await mkDoc(`${P}d14`, "- the deleted project pays in dollars", gone);
    // Teardown's half of the interleaving: it runs while no space exists yet.
    await retireProjectSpace(gone);
    expect(await spaceOf("project", gone)).not.toBeNull(); // a tombstone, not silence

    await expect(migrate(`${P}d14`)).resolves.toEqual({ migrated: 0 });

    const spaceId = (await spaceOf("project", gone))!;
    expect(await count("spaces", "id = $1 AND retired_at IS NOT NULL", [spaceId])).toBe(1);
    expect(await waiting(spaceId)).toEqual([]);
    expect(await statements(spaceId)).toEqual([]);
    expect(await count("vault_notes", "space_id = $1", [spaceId])).toBe(0);
    // Stamped rather than retried: a deleted project's document is nothing to carry,
    // not a failure to re-drive on every boot.
    expect(await migratedAt(`${P}d14`)).not.toBeNull();
  });

  it("a failure logs a discriminated shape and NEVER the statement text", async () => {
    // Drizzle embeds every bound parameter in the error message, so logging the error
    // whole would write a screened credential verbatim into the application log and
    // every attached collector — defeating the screen that kept it out of the prompt.
    // The mocked `createClaim` throws with the statement genuinely inside `message`,
    // so this fails if the module ever logs the error object again.
    const secret = "sk-live-abc123SECRETVALUE";
    await mkDoc(`${P}d11`, `- ${secret}`);
    hook.failOn = secret;

    await expect(migrate(`${P}d11`)).rejects.toThrow();

    const entry = logged.errors.find((e) => e.ctx?.docId === `${P}d11`);
    expect(entry).toBeDefined();
    // What an operator legitimately needs: which row, which fault, how many tries.
    expect(entry!.ctx).toMatchObject({
      docId: `${P}d11`,
      attempts: 1,
      code: "23503",
      constraint: "mcand_space_fk",
    });
    // And what must never travel: the value, or any raw message that carries it.
    expect(JSON.stringify(logged.errors)).not.toContain(secret);
    expect(JSON.stringify(logged.errors)).not.toContain("Failed query");
    expect(entry!.ctx).not.toHaveProperty("message");
    expect(entry!.ctx).not.toHaveProperty("err");
  });

  it("the batch rethrow carries nothing raw either — the cause chain is scrubbed too", async () => {
    // The other half of the rule above, and the one it was missing: the scrubber sat on
    // the log CALL while the batch rethrow attached the raw first error as `cause`. The
    // only caller does `console.error(…, e)`, and Node's inspector prints the whole
    // cause chain — so the credential the line above kept out of the log went to stdout
    // anyway, once per retry pass. `inspect` is used here precisely because it is what
    // `console.error` does to an Error; asserting on `.message` alone would pass on the
    // defect.
    const secret = "sk-live-def456CAUSECHAIN";
    await mkDoc(`${P}d13`, `- ${secret}`);
    hook.failOn = secret;

    const err = await migrate(`${P}d13`).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`1 memory doc(s) did not migrate: ${P}d13`);
    const printed = inspect(err, { depth: null });
    expect(printed).not.toContain(secret);
    expect(printed).not.toContain("Failed query");
    // Still discriminated enough for an operator to act on — the fault, not the data.
    expect((err as { cause?: unknown }).cause).toMatchObject({ code: "23503", constraint: "mcand_space_fk" });
  });

  it("a deterministically failing document is retried a bounded number of times, then left alone", async () => {
    // One broken row must not re-drive forever against the 60-second boot retry.
    await mkDoc(`${P}d12`, "- poisonous");
    hook.failOn = "poisonous";

    // Five attempts, each still reporting failure so the boot loop stays armed.
    for (let i = 0; i < 5; i++) {
      await expect(migrate(`${P}d12`)).rejects.toThrow(`did not migrate: ${P}d12`);
    }
    expect(logged.errors.some((e) => e.msg.includes("giving up") && e.ctx?.docId === `${P}d12`)).toBe(true);

    // Sixth: no longer selected, so nothing fails and the retry loop RETURNS rather
    // than spinning. That is what ends the growth, not the log line.
    logged.errors.length = 0;
    await expect(migrate(`${P}d12`)).resolves.toEqual({ migrated: 0 });
    expect(logged.errors).toHaveLength(0);
    expect(await migratedAt(`${P}d12`)).toBeNull();
  });
});
