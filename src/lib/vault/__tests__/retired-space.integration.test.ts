import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * The lifecycle fence: nothing writes into a space the user already deleted.
 *
 * Post-turn extraction deliberately OUTLIVES its task (it runs after the reply is
 * delivered), while project deletion uses task activity as its liveness signal — so
 * the turn is `completed`, the delete is allowed, and an auxiliary model call that
 * takes seconds returns into a space that no longer exists for the user. Nothing is
 * mocked here, `retireProjectSpace` least of all: a stubbed retire would fix the
 * interleaving by hand and the test would then be checking an assumption about the
 * race instead of the race.
 */
import { and, eq } from "drizzle-orm";
import { db, pool } from "@/lib/db";
import { vaultClaims } from "@/lib/db/schema";
import { createClaim, updateClaim, type Actor } from "../claims";
import { proposeCandidate } from "../candidates";
import { extractCandidates } from "../extract";
import { getOrCreateSpace, retireProjectSpace } from "../spaces";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Every fixture id carries this prefix, so cleanup is one LIKE per table. Space ids
 *  are minted inside `getOrCreateSpace`, so those are caught by owner_user_id. */
const P = "retiredtest-";
const OWNER = `${P}owner`;
const MSG = `${P}msg`;
const PROJ = `${P}proj`;

const actor: Actor = { kind: "agent" };

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const count = async (table: string, where: string, params: unknown[]) => {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, params);
  return Number(rows[0].n);
};

/** What the space holds, in one shot: the fence is about a fact ARRIVING, and a fact
 *  arrives as a claim, a candidate awaiting review, or the topic note either of them
 *  would be filed under. Asserting only on claims would pass while the review queue
 *  quietly refilled. */
const contents = async (spaceId: string) => ({
  claims: await count("vault_claims", "space_id = $1", [spaceId]),
  candidates: await count("memory_candidates", "space_id = $1", [spaceId]),
  notes: await count("vault_notes", "space_id = $1", [spaceId]),
});

/** users.email is unique too — a targeted ON CONFLICT (id) would raise 23505 on a
 *  leftover row with the same email, which reads like a skipped test. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'retired space test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

/** A deferred, so a transaction can be held open across an await in the test body. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const cleanup = () => q(`DELETE FROM spaces WHERE owner_user_id = $1`, [OWNER]);

run("vault: writes into a retired space", () => {
  beforeAll(() => mkUser(OWNER));
  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });
  beforeEach(cleanup);

  const spaces = async () => ({
    userSpaceId: await getOrCreateSpace({ type: "user", refId: OWNER }),
    projectSpaceId: await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER }),
  });

  it("an extraction that returns AFTER the project was deleted writes nothing", async () => {
    const { userSpaceId, projectSpaceId } = await spaces();
    const generating = deferred();

    // The real product path: the turn has answered, the aux model is still generating,
    // and the user deletes the project in that window.
    const extraction = extractCandidates({
      userSpaceId,
      projectSpaceId,
      messageId: MSG,
      userText: "we pay our suppliers in euros",
      assistantText: "noted",
      generate: async () => {
        await generating.promise;
        return {
          text: JSON.stringify([{ statement: "we pay our suppliers in euros", from: "user", scope: "project" }]),
          finishReason: "stop",
        };
      },
    });

    await retireProjectSpace(PROJ);
    generating.resolve();
    // Extraction never throws into its caller — it runs after the turn already
    // succeeded — so the assertion has to be about the rows, not about a rejection.
    await expect(extraction).resolves.toBeUndefined();

    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
  });

  it("a write already in flight BLOCKS on the retire and then refuses", async () => {
    // The window at its narrowest: the retire is uncommitted and holding the space
    // row, and the proposal arrives inside it.
    //
    // The `blocked` assertion below is NOT what proves the lock — an insert into the
    // space blocks on the foreign key's own row lock anyway, so it is green either way.
    // What proves it is the OUTCOME: with a locking read the proposal waits, re-reads
    // the committed row and returns `retired` cleanly. With a plain read it takes its
    // own older snapshot, passes the fence, writes the candidate — and only the next
    // statement, on a fresh READ COMMITTED snapshot, notices and throws, which reaches
    // extraction as a logged error instead of a turn that simply arrived late.
    const { projectSpaceId } = await spaces();
    const retired = deferred();
    const holding = deferred();
    const retire = db.transaction(async (tx) => {
      await retireProjectSpace(PROJ, tx);
      retired.resolve();
      await holding.promise;
    });
    await retired.promise;

    const propose = proposeCandidate({
      idempotencyKey: `${P}inflight`,
      spaceId: projectSpaceId,
      statement: "invoices are approved by the head of finance",
      provenance: { kind: "user_direct", messageId: MSG },
    });
    const outcome = await Promise.race([
      propose.then(() => "done" as const),
      new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 500)),
    ]);
    expect(outcome).toBe("blocked");

    holding.resolve();
    await retire;
    expect(await propose).toEqual({ state: "retired" });
    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
  });

  it("a PENDING proposal leaves no candidate row either", async () => {
    // The claim fence cannot cover this one: a proposal that is not the user's own
    // words never reaches `createClaim` at all — it stops at a candidate row, which is
    // memory the user would meet in the review queue with the statement in full. So
    // this is the case that proves the ledger holds its own bound rather than
    // inheriting one from claims.ts.
    const { projectSpaceId } = await spaces();
    await retireProjectSpace(PROJ);
    const res = await proposeCandidate({
      idempotencyKey: `${P}pending`,
      spaceId: projectSpaceId,
      statement: "the supplier raised prices in March",
      provenance: { kind: "derived", messageId: MSG },
    });
    expect(res).toEqual({ state: "retired" });
    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
    // And no audit event: a refused proposal is not a decision the space records — the
    // space is closed, and `space.retire` is the last thing written into it.
    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.propose'", [projectSpaceId])).toBe(0);
  });

  it("createClaim refuses to open a chain in a retired space", async () => {
    const { projectSpaceId } = await spaces();
    await retireProjectSpace(PROJ);
    await expect(
      createClaim(
        {
          spaceId: projectSpaceId,
          statement: "the office moves in March",
          origin: { kind: "user_direct" },
          reviewStatus: "confirmed",
        },
        actor,
      ),
    ).rejects.toThrow(/retired/i);
    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
  });

  it("updateClaim refuses to add a successor in a retired space", async () => {
    // A claim that outlived the retire is not hypothetical: a supersede committing
    // just after the retire's DELETE took its snapshot leaves the SUCCESSOR behind,
    // which is the very shape the fence exists to stop from happening twice.
    const { projectSpaceId } = await spaces();
    await retireProjectSpace(PROJ);
    const claimId = `${P}survivor`;
    await q(`INSERT INTO vault_claims (id, space_id, statement, origin) VALUES ($1, $2, 'a fact', '{}'::jsonb)`, [
      claimId,
      projectSpaceId,
    ]);

    await expect(
      updateClaim({
        claimId,
        expectedRevision: 1,
        patch: { statement: "a corrected fact" },
        allowedSpaceIds: [projectSpaceId],
        actor,
      }),
    ).rejects.toThrow(/retired/i);

    // The whole move rolled back: the predecessor is still the head, so a refused
    // update is not a silent forget.
    const [head] = await db
      .select({ supersededAt: vaultClaims.supersededAt })
      .from(vaultClaims)
      .where(and(eq(vaultClaims.id, claimId), eq(vaultClaims.spaceId, projectSpaceId)));
    expect(head?.supersededAt).toBeNull();
    expect(await count("vault_claims", "space_id = $1", [projectSpaceId])).toBe(1);
  });

  it("a LIVE space still takes all three writes", async () => {
    // The control: a fence that refused everything would pass every assertion above.
    const { userSpaceId, projectSpaceId } = await spaces();
    const proposed = await proposeCandidate({
      idempotencyKey: `${P}live`,
      spaceId: projectSpaceId,
      statement: "we pay our suppliers in euros",
      provenance: { kind: "user_direct", messageId: MSG },
    });
    expect(proposed.state).toBe("auto_active");

    const created = await createClaim(
      { spaceId: userSpaceId, statement: "works in procurement", origin: {}, reviewStatus: "confirmed" },
      actor,
    );
    const updated = await updateClaim({
      claimId: created.id,
      expectedRevision: created.revision,
      patch: { statement: "works in procurement, Kyiv office" },
      allowedSpaceIds: [userSpaceId],
      actor,
    });
    expect(updated.ok).toBe(true);
  });

  it("retiring the PROJECT space leaves the user's own space writable", async () => {
    // Deleting a project deletes that project's memory, not the person's — an
    // over-broad fence would take the user space with it, and the same turn's
    // user-scoped facts would vanish for good.
    const { userSpaceId, projectSpaceId } = await spaces();
    await retireProjectSpace(PROJ);
    const generating = deferred();
    const extraction = extractCandidates({
      userSpaceId,
      projectSpaceId,
      messageId: MSG,
      userText: "I work in procurement and we pay our suppliers in euros",
      assistantText: "noted",
      generate: async () => {
        await generating.promise;
        return {
          text: JSON.stringify([
            { statement: "works in procurement", from: "user", scope: "user" },
            { statement: "we pay our suppliers in euros", from: "user", scope: "project" },
          ]),
          finishReason: "stop",
        };
      },
    });
    generating.resolve();
    await extraction;

    expect(await count("vault_claims", "space_id = $1", [userSpaceId])).toBe(1);
    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
  });
});
