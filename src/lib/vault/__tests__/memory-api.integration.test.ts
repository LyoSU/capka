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
 */
import { pool } from "@/lib/db";
import { createClaim } from "../claims";
import { DEFAULT_TOPIC_KEY, getOrCreateSpace, getOrCreateTopicNote } from "../spaces";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Every fixture id carries this prefix; spaces are caught by owner_user_id. */
const P = "memapi-";
const OWNER = `${P}owner`;
const STRANGER = `${P}stranger`;

/** The sensitive fixture's words. Named once, asserted against the response body: the
 *  point of this route is that a human removes this claim without anyone — the model,
 *  the wire, the page — ever being told what it says. */
const SECRET = "attends a support group on Thursday evenings";

const { requireWriter } = vi.hoisted(() => ({ requireWriter: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireWriter };
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

/** The space drags its topics, claims, memberships and audit events along with it. */
const cleanup = () => q(`DELETE FROM spaces WHERE owner_user_id LIKE $1`, [`${P}%`]);

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
