import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * `DELETE /api/memory/claims/<id>` — the human's delete, and the far end of the dead
 * end recorded on `memory_forget`. What has to be proven here is not "the row is gone"
 * but the three properties that made this route worth building:
 *
 *   - a SENSITIVE claim is deletable, and its words appear nowhere in the exchange;
 *   - somebody else's claim answers exactly as a non-existent one does, and is untouched;
 *   - the audit event names the PERSON, which is what tells this deletion apart from the
 *     agent's afterwards.
 *
 * Against the real database, because every one of those is an ownership filter or a
 * write — the two things a mocked `db` would simply agree with.
 *
 * The second block covers `DELETE /api/memory` — "forget everything" — whose properties
 * are the same kind and one more besides: the audit trail has to SURVIVE it. That trail
 * is the only record that the reset happened at all, so collecting it in the same sweep
 * would erase the evidence of the very act.
 */
import { pool } from "@/lib/db";
import { createClaim } from "../claims";
import type { ScopeView } from "../memory-page";
import { DEFAULT_TOPIC_KEY, getOrCreateSpace, getOrCreateTopicNote } from "../spaces";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Every fixture id carries this prefix; spaces are caught by owner_user_id. */
const P = "memapi-";
const OWNER = `${P}owner`;
const STRANGER = `${P}stranger`;
/** A project of the owner's. "Forget everything" spans every scope they own, so one
 *  scope is not enough to tell a working sweep from a query that only ever saw the
 *  user's own space. */
const PROJECT = `${P}project`;

/** The sensitive fixture's words. Named once, asserted against the response body: the
 *  point of this route is that a human removes this claim without anyone — the model,
 *  the wire, the page — ever being told what it says. */
const SECRET = "attends a support group on Thursday evenings";

const { requireWriter, requireActive } = vi.hoisted(() => ({ requireWriter: vi.fn(), requireActive: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireWriter, requireActive };
});

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

/** users.email is unique too, so the conflict target must stay untargeted — a leftover
 *  row with this email would otherwise raise 23505 inside `beforeAll`, which surfaces as
 *  skipped tests rather than as a failure. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'memory api test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

/** A confirmed head filed under the default topic — what the page renders and this route
 *  deletes. `sensitive` is a parameter because the whole question is whether the two
 *  travel the same path. */
const mkClaim = async (spaceId: string, statement: string, sensitive = false) => {
  const topicNoteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
  const { id } = await createClaim(
    { spaceId, statement, origin: { kind: "user_direct" }, reviewStatus: "confirmed", sensitive, topicNoteId },
    { kind: "system" },
  );
  return id;
};

const del = async (claimId: string) => {
  const { DELETE } = await import("@/app/api/memory/claims/[claimId]/route");
  return DELETE(new Request("http://t", { method: "DELETE" }), { params: Promise.resolve({ claimId }) });
};

const supersededAt = async (claimId: string) => {
  const { rows } = await q(`SELECT superseded_at FROM vault_claims WHERE id = $1`, [claimId]);
  return (rows[0] as { superseded_at: Date | null } | undefined)?.superseded_at ?? null;
};

/** The space drags its topics, claims, memberships and audit events along with it.
 *  `projects` is not reached by that cascade — a space's `ref_id` is polymorphic and
 *  carries no foreign key — so the project row is removed beside it. */
const cleanup = async () => {
  await q(`DELETE FROM spaces WHERE owner_user_id LIKE $1`, [`${P}%`]);
  await q(`DELETE FROM projects WHERE id = $1`, [PROJECT]);
};

run("vault: DELETE /api/memory/claims/[claimId]", () => {
  let plainClaimId = "";
  let sensitiveClaimId = "";

  beforeAll(async () => {
    await mkUser(OWNER);
    await mkUser(STRANGER);
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM "user" WHERE id IN ($1, $2)`, [OWNER, STRANGER]);
  });

  // Fixtures are rebuilt per test rather than shared: three of the four tests here are
  // about what happened to a row, and a row one test deleted is not a fixture the next
  // one can assert is untouched.
  beforeEach(async () => {
    await cleanup();
    requireWriter.mockResolvedValue({ userId: OWNER, role: "user", status: "active" });
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    plainClaimId = await mkClaim(spaceId, "works in procurement");
    sensitiveClaimId = await mkClaim(spaceId, SECRET, true);
  });

  it("lets the person delete a fact by address", async () => {
    const res = await del(plainClaimId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await supersededAt(plainClaimId)).not.toBeNull();
  });

  it("lets the person delete a SENSITIVE fact without ever being told what it says", async () => {
    // The claim `memory_search` withholds and `memory_forget` cannot name. No words are
    // sent and none come back — the request is an id the user's own screen gave them.
    const res = await del(sensitiveClaimId);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("support group");
    expect(await supersededAt(sensitiveClaimId)).not.toBeNull();
  });

  it("refuses somebody else's fact as if it did not exist", async () => {
    requireWriter.mockResolvedValue({ userId: STRANGER, role: "user", status: "active" });
    const res = await del(plainClaimId);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    // A 404 that still deleted the row would pass an assertion on the status alone.
    expect(await supersededAt(plainClaimId)).toBeNull();
  });

  it("leaves an audit event naming the person, not the agent", async () => {
    await del(plainClaimId);
    const ev = await q(
      `SELECT actor->>'kind' AS kind, actor->>'id' AS id FROM audit_events
        WHERE action = 'claim.forget' AND subject_id = $1`,
      [plainClaimId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ kind: "user", id: OWNER });
  });
});

run("vault: DELETE /api/memory — forget everything", () => {
  let userSpaceId = "";
  let projectSpaceId = "";
  let strangerClaimId = "";

  const reset = async () => {
    const { DELETE } = await import("@/app/api/memory/route");
    return DELETE();
  };

  /** The page the person is looking at, read back through its own endpoint rather than
   *  through the projection module: the assertion is about what the SCREEN shows after
   *  the reset, and the screen is fed by this route. */
  const page = async () => {
    const { GET } = await import("@/app/api/memory/route");
    return (await GET()).json() as Promise<{ scopes: ScopeView[] }>;
  };

  beforeAll(async () => {
    await mkUser(OWNER);
    await mkUser(STRANGER);
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM "user" WHERE id IN ($1, $2)`, [OWNER, STRANGER]);
  });

  beforeEach(async () => {
    await cleanup();
    requireWriter.mockResolvedValue({ userId: OWNER, role: "user", status: "active" });
    requireActive.mockResolvedValue({ userId: OWNER, role: "user", status: "active" });

    userSpaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await mkClaim(userSpaceId, "works in procurement");
    await mkClaim(userSpaceId, SECRET, true);

    await q(`INSERT INTO projects (id, user_id, name) VALUES ($1, $2, 'memory reset test')`, [PROJECT, OWNER]);
    projectSpaceId = await getOrCreateSpace({ type: "project", refId: PROJECT, ownerUserId: OWNER });
    await mkClaim(projectSpaceId, "the quarterly report goes out on Fridays");

    // One fact still waiting for a decision. Written straight into the table: the point
    // here is what the reset does to an unresolved row, not how the ledger produced it.
    await q(
      `INSERT INTO memory_candidates (id, idempotency_key, space_id, statement, provenance, policy_state)
       VALUES ($1, $1, $2, $3, '{"kind":"derived"}'::jsonb, 'pending')`,
      [`${P}cand`, userSpaceId, "Prefers meetings before noon"],
    );

    const strangerSpaceId = await getOrCreateSpace({ type: "user", refId: STRANGER });
    strangerClaimId = await mkClaim(strangerSpaceId, "keeps their own notes");
  });

  it("forgets everything in every scope the caller owns, and nobody else's", async () => {
    const res = await reset();
    expect(res.status).toBe(200);
    // Three heads: two in the user's own space, one in their project's.
    expect(await res.json()).toEqual({ forgotten: 3 });

    const body = await page();
    expect(body.scopes.flatMap((s) => s.topics.flatMap((t) => t.facts))).toHaveLength(0);
    // The waiting list goes with it. A review queue that survived "forget everything"
    // would offer the person, a moment later, the very facts they just erased.
    expect(body.scopes.flatMap((s) => s.pending)).toHaveLength(0);
  });

  /** Its own test rather than a fourth assertion above, and the ordering is the reason:
   *  every assertion up there fails first under a missing owner filter, so this one would
   *  never be the thing that reported it — and it is the only assertion here about
   *  somebody ELSE's memory. */
  it("leaves another person's memory alone", async () => {
    await reset();
    const theirs = await q(`SELECT superseded_at FROM vault_claims WHERE id = $1`, [strangerClaimId]);
    expect((theirs.rows[0] as { superseded_at: Date | null }).superseded_at).toBeNull();
  });

  it("never says what a sensitive fact said, not even while destroying it", async () => {
    const res = await reset();
    expect(JSON.stringify(await res.json())).not.toContain("support group");
    expect(JSON.stringify(await page())).not.toContain("support group");
  });

  it("leaves the audit trail behind", async () => {
    await reset();
    // Per space, because that is the grain `audit_events` is scoped at — a sweep that
    // only ever reached the user's own space would still satisfy a global count.
    for (const spaceId of [userSpaceId, projectSpaceId]) {
      const ev = await q(
        `SELECT count(*)::int AS n FROM audit_events WHERE action = 'claim.forget' AND space_id = $1`,
        [spaceId],
      );
      expect((ev.rows[0] as { n: number }).n).toBeGreaterThan(0);
    }
    const rejected = await q(
      `SELECT actor->>'kind' AS kind, actor->>'id' AS id, payload->>'bulk' AS bulk FROM audit_events
        WHERE action = 'candidate.reject' AND subject_id = $1`,
      [`${P}cand`],
    );
    expect(rejected.rows).toHaveLength(1);
    // The person, not the agent — and marked as part of a reset rather than as one of
    // the decisions the review queue asks them for.
    expect(rejected.rows[0]).toMatchObject({ kind: "user", id: OWNER, bulk: "true" });
  });
});
