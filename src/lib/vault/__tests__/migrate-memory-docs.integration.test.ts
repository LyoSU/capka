import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * Migrating legacy memory_docs into the knowledge store. Nothing but `createClaim`
 * is mocked: the whole point of this module is the CAS on the document row and
 * which rows Postgres rolls back along with `migrated_at` when something fails
 * mid-document. An in-memory double would be testing its own imagination.
 *
 * EVERY call passes `docIds`. Without it `migrateMemoryDocs()` by construction takes
 * EVERY unmigrated document in the database — and this database is shared, holding
 * a developer's real memory: the suite would migrate it and leave behind a space, a
 * topic, claims and a set `migrated_at` that no prefix-scoped DELETE cleans up.
 * The assertions are scoped too (`space_id = $1`, prefixed ids) — the worker lives
 * next door.
 */
import { pool } from "@/lib/db";
import { getOrCreateSpace } from "../spaces";
import { migrateMemoryDocs } from "../migrate-memory-docs";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** A "mid-document" failure is keyed on the bullet's TEXT, not on a call ordinal:
 *  the order of documents in the selection is undefined, so "the third call" is not
 *  a variable we control, while "the third bullet of THIS document" is. */
const hook = vi.hoisted(() => ({ failOn: null as string | null }));

vi.mock("../claims", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claims")>();
  return {
    ...actual,
    createClaim: (...args: Parameters<typeof actual.createClaim>) => {
      if (hook.failOn && args[0].statement === hook.failOn) {
        throw new Error(`mdmig: deliberate failure on bullet \"${hook.failOn}\"`);
      }
      return actual.createClaim(...args);
    },
  };
});

/** Every fixture id carries this prefix. Space ids are not ours to choose (nanoid,
 *  from the inside), so those are caught by owner_user_id instead. */
const P = "mdmig-";
const OWNER = `${P}owner`;
const PROJ = `${P}proj`;

/** Migrate only the named documents — see the note at the top of the suite. */
const migrate = (...docIds: string[]) => migrateMemoryDocs({ docIds });

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

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

const statements = async (spaceId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ statement: string }>(
    `SELECT statement FROM vault_claims WHERE space_id = $1 AND superseded_at IS NULL`,
    [spaceId],
  );
  return rows.map((r) => r.statement);
};

/** What the GET actually shows: claims ATTACHED to the default topic. A claim with
 *  no topic stays in the table and vanishes from the screen — a difference a plain
 *  claim count does not catch. */
const inTopic = async (spaceId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ statement: string }>(
    `SELECT c.statement FROM vault_claims c
       JOIN note_claims nc ON nc.claim_id = c.id
       JOIN vault_notes n ON n.id = nc.note_id
      WHERE c.space_id = $1 AND c.superseded_at IS NULL AND n.title = 'General' AND n.kind = 'memory_topic'`,
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

const snapshots = async (spaceId: string) => {
  const { rows } = await pool.query<{ actor: unknown; payload: { content?: string; docId?: string } }>(
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
    await q(`DELETE FROM projects WHERE id = $1`, [PROJ]);
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });

  beforeEach(async () => {
    hook.failOn = null;
    await cleanup();
  });

  it("a document's bullets become confirmed legacy claims in the default topic, plus a snapshot", async () => {
    const content = "- likes tea\n\n* deadline on Friday\n  - works from Lviv\n";
    await mkDoc(`${P}d1`, content);

    expect(await migrate(`${P}d1`)).toEqual({ migrated: 1 });

    const spaceId = await spaceOf("user", OWNER);
    expect(spaceId).not.toBeNull();
    expect(new Set(await statements(spaceId!))).toEqual(
      new Set(["likes tea", "deadline on Friday", "works from Lviv"]),
    );
    // Origin and status are what Task 8 uses to tell migrated from new, and without
    // them a manifest of confirmed facts would not show the document at all.
    expect(
      await count(
        "vault_claims",
        "space_id = $1 AND review_status = 'confirmed' AND origin->>'kind' = 'legacy_memory_doc'",
        [spaceId],
      ),
    ).toBe(3);

    // A claim with no topic is invisible to the note projection, i.e. does not exist
    // for the UI.
    expect(await inTopic(spaceId!)).toHaveLength(3);

    // The only copy of the original markdown that survives the move.
    const events = await snapshots(spaceId!);
    expect(events).toHaveLength(1);
    expect(events[0].payload.content).toBe(content);
    expect(events[0].payload.docId).toBe(`${P}d1`);
    expect(events[0].actor).toEqual({ kind: "system" });

    expect(await migratedAt(`${P}d1`)).not.toBeNull();
  });

  it("a second call adds nothing and does not re-stamp the document", async () => {
    await mkDoc(`${P}d2`, "- one\n- two");
    await migrate(`${P}d2`);

    const spaceId = (await spaceOf("user", OWNER))!;
    const stamp = await migratedAt(`${P}d2`);
    expect(stamp).not.toBeNull();

    expect(await migrate(`${P}d2`)).toEqual({ migrated: 0 });

    expect(await count("vault_claims", "space_id = $1", [spaceId])).toBe(2);
    expect(await snapshots(spaceId)).toHaveLength(1);
    expect(await migratedAt(`${P}d2`)).toEqual(stamp);
  });

  it("a race between two migrations duplicates no claim (CAS on the document row)", async () => {
    await mkDoc(`${P}d3`, "- fact A\n- fact B");

    const [a, b] = await Promise.all([migrate(`${P}d3`), migrate(`${P}d3`)]);

    // Exactly one of the two claimed the document — the other saw zero rows on the CAS.
    expect(a.migrated + b.migrated).toBe(1);
    const spaceId = (await spaceOf("user", OWNER))!;
    expect(await statements(spaceId)).toHaveLength(2);
    expect(await inTopic(spaceId)).toHaveLength(2);
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
    expect(new Set(await statements(spaceId))).toEqual(new Set(["one", "two", "three", "four"]));
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
    expect(await statements((await spaceOf("project", PROJ))!)).toEqual(["a neighbouring fact"]);

    expect(await migratedAt(`${P}d8bad`)).toBeNull();
    expect(await spaceOf("user", OWNER)).toBeNull();
  });

  it("an empty document is stamped and produces no claims", async () => {
    await mkDoc(`${P}d5`, "");

    await migrate(`${P}d5`);

    expect(await migratedAt(`${P}d5`)).not.toBeNull();
    const spaceId = (await spaceOf("user", OWNER))!;
    expect(await count("vault_claims", "space_id = $1", [spaceId])).toBe(0);
    const events = await snapshots(spaceId);
    expect(events).toHaveLength(1);
    expect(events[0].payload.content).toBe("");
  });

  it("a bullet that already exists as a topicless claim is not duplicated — and joins the default topic", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    // A head with NO topic attachment — exactly what a partial run, or a claim created
    // outside the candidate ledger, leaves behind.
    await q(
      `INSERT INTO vault_claims (id, space_id, statement, origin, review_status)
       VALUES ($1, $2, 'Likes   tea', '{"kind":"legacy_memory_doc"}'::jsonb, 'confirmed')`,
      [`${P}claim`, spaceId],
    );
    await mkDoc(`${P}d6`, "- likes tea\n- something new");

    await migrate(`${P}d6`);

    // The same normalization as in the candidate ledger: case and repeated spaces do
    // not turn one fact into two.
    expect(new Set(await statements(spaceId))).toEqual(new Set(["Likes   tea", "something new"]));
    // And skipping the bullet does not leave the fact off the screen: the GET reads
    // the default topic only.
    expect(new Set(await inTopic(spaceId))).toEqual(new Set(["Likes   tea", "something new"]));
    expect(await count("note_claims", "claim_id = $1", [`${P}claim`])).toBe(1);
  });

  it("a bullet matching an UNVERIFIED head confirms it, instead of hiding the legacy fact", async () => {
    // The legacy document is memory the user has been looking at and silently
    // accepting; it is no less confirmed than whatever is already in the vault.
    // Attaching without confirming stamps the document migrated while the manifest —
    // which reads confirmed claims only — still shows nothing, so the fact exists in
    // the database and is gone from the screen.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await q(
      `INSERT INTO vault_claims (id, space_id, statement, origin, review_status, sensitive)
       VALUES ($1, $2, 'Likes tea', '{"kind":"derived"}'::jsonb, 'unverified', true)`,
      [`${P}unverified`, spaceId],
    );
    await mkDoc(`${P}d9`, "- likes tea");

    await migrate(`${P}d9`);

    expect(
      await count("vault_claims", "id = $1 AND review_status = 'confirmed'", [`${P}unverified`]),
    ).toBe(1);
    // Confirming is not licence to declassify: sensitivity only ever rises.
    expect(await count("vault_claims", "id = $1 AND sensitive = true", [`${P}unverified`])).toBe(1);
    // A confirmation is not a new version — the statement did not change.
    expect(await count("vault_claims", "space_id = $1", [spaceId])).toBe(1);
    expect(await inTopic(spaceId)).toEqual(["Likes tea"]);
  });

  it("a project's document lands in the project space, owned by the document's owner", async () => {
    await mkDoc(`${P}d7`, "- a project fact", PROJ);

    await migrate(`${P}d7`);

    const spaceId = await spaceOf("project", PROJ);
    expect(spaceId).not.toBeNull();
    expect(await count("spaces", "id = $1 AND owner_user_id = $2", [spaceId, OWNER])).toBe(1);
    expect(await statements(spaceId!)).toEqual(["a project fact"]);
  });
});
