import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * The candidate ledger is the only way into memory, and three of its properties do
 * not exist outside a real Postgres: the partial unique on the slot, which turns a
 * race between two proposals into a 23505; the SAVEPOINT, without which that 23505
 * aborts the WHOLE transaction (making recovery impossible by construction); and
 * the CAS on `memory_candidates`, which arbitrates confirm/confirm and
 * confirm/reject. An in-memory double would be testing its own imagination about
 * each of the three.
 */

/** Mock control lives in a hoisted object: the `vi.mock` factory is lifted above
 *  the imports, so an ordinary `const` here would hit the TDZ. Both levers are off
 *  by default — the real module runs. */
const ctl = vi.hoisted(() => ({
  casLosses: 0,
  createError: null as unknown,
  beforeCreate: null as null | (() => Promise<void>),
}));

vi.mock("../claims", async (importOriginal) => {
  const real = await importOriginal<typeof import("../claims")>();
  return {
    ...real,
    createClaim: async (...args: Parameters<typeof real.createClaim>) => {
      if (ctl.createError) throw ctl.createError;
      // The "a competitor committed BETWEEN our headBySlot and our insert" window is
      // the only way to reproduce a slot 23505 deterministically.
      const hook = ctl.beforeCreate;
      ctl.beforeCreate = null;
      if (hook) await hook();
      return real.createClaim(...args);
    },
    updateClaim: (...args: Parameters<typeof real.updateClaim>) => {
      if (ctl.casLosses > 0) {
        ctl.casLosses--;
        return Promise.resolve({ ok: false as const, current: null });
      }
      return real.updateClaim(...args);
    },
  };
});

import { pool } from "@/lib/db";
import { createClaim, type Actor } from "../claims";
import {
  proposeCandidate,
  confirmCandidate,
  rejectCandidate,
  listOpenCandidates,
  verifyDirectProvenance,
  type Provenance,
} from "../candidates";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Fixture prefix: everything is cleaned up by one DELETE over the spaces (the
 *  cascade takes candidates, claims, notes, attachments, evidence and audit rows). */
const P = "candtest-";
const OWNER = `${P}owner`;
const SPACE_A = `${P}space-a`; // "my" space
const SPACE_B = `${P}space-b`; // someone else's: exercises authz
const NOTE_A = `${P}note-a`;
const ACTOR: Actor = { kind: "user", id: OWNER };
const DIRECT: Provenance = { kind: "user_direct", messageId: `${P}msg` };

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const count = async (table: string, where: string, params: unknown[]) => {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, params);
  return Number(rows[0].n);
};

const candRow = async (id: string) => {
  const { rows } = await pool.query<{
    id: string;
    policy_state: string;
    claim_id: string | null;
    conflicts_with: string | null;
    resolved_at: Date | null;
    evidence: unknown;
    sensitive: boolean;
    slot_key: string | null;
    provenance: Record<string, unknown>;
  }>(`SELECT * FROM memory_candidates WHERE id = $1`, [id]);
  return rows[0];
};

const claimRow = async (id: string) => {
  const { rows } = await pool.query<{
    statement: string;
    slot_key: string | null;
    value: unknown;
    origin: Record<string, unknown>;
    review_status: string;
    sensitive: boolean;
    revision: number;
    supersedes: string | null;
    superseded_at: Date | null;
  }>(`SELECT * FROM vault_claims WHERE id = $1`, [id]);
  return rows[0];
};

/** A claim attached to the default topic — exactly what the Task 10 GET reads. */
const inDefaultTopic = async (claimId: string) =>
  count(
    "note_claims nc JOIN vault_notes n ON n.id = nc.note_id",
    "nc.claim_id = $1 AND n.title = 'General' AND n.kind = 'memory_topic' AND n.space_id = $2",
    [claimId, SPACE_A],
  );

/** users.email is unique too — a targeted ON CONFLICT (id) would raise 23505 on a
 *  leftover row with the same email, which reads like a skipped test. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'candidates test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

const cleanup = () => q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);

const fixtures = async () => {
  await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'user', $2, $2)`, [SPACE_A, OWNER]);
  await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'project', $2, $3)`, [
    SPACE_B,
    `${P}proj`,
    OWNER,
  ]);
  await q(`INSERT INTO vault_notes (id, space_id, title, kind) VALUES ($1, $2, 'Topic', 'memory_topic')`, [
    NOTE_A,
    SPACE_A,
  ]);
};

let seq = 0;
/** The idempotency key is unique per call unless a test sets it explicitly —
 *  otherwise a second propose in the same test would silently become `duplicate`. */
const propose = (over: Partial<Parameters<typeof proposeCandidate>[0]> = {}) =>
  proposeCandidate({
    idempotencyKey: `${P}idem-${++seq}`,
    spaceId: SPACE_A,
    statement: "a default fact",
    provenance: DIRECT,
    ...over,
  });

run("vault candidates", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });

  beforeEach(async () => {
    ctl.casLosses = 0;
    ctl.createError = null;
    ctl.beforeCreate = null;
    await cleanup();
    await fixtures();
  });

  /** A competitor committing on a SEPARATE connection (pool = autocommit) while our
   *  outer transaction is open: exactly the situation in which the claim insert hits
   *  a real 23505 from Postgres rather than a simulated one. */
  const competitorTakesSlot = (slotKey: string, statement: string) => {
    const id = `${P}rival-${slotKey}`;
    ctl.beforeCreate = async () => {
      await q(
        `INSERT INTO vault_claims (id, space_id, statement, slot_key, origin, review_status)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 'confirmed')`,
        [id, SPACE_A, statement, slotKey],
      );
    };
    return id;
  };

  it("a competitor takes the slot BETWEEN the read and the insert: SAVEPOINT swallows the 23505 → merged", async () => {
    const rival = competitorTakesSlot("det-merge", "Lives in Odesa");

    const res = await propose({
      statement: "lives   in odesa",
      slotKey: "det-merge",
      evidence: [{ messageId: `${P}msg` }],
    });

    // No unique violation escapes — that is exactly what the SAVEPOINT is for.
    expect(res).toEqual({ state: "merged", claimId: rival });
    // Our claim rolled back with the savepoint; there is one head, the competitor's.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [rival])).toBe(1);
    // The outer transaction SURVIVED the error: the candidate row is committed.
    expect(await count("memory_candidates", "space_id = $1 AND resolved_at IS NOT NULL AND claim_id = $2", [SPACE_A, rival])).toBe(1);
  });

  it("a competitor takes the slot with different text: SAVEPOINT swallows the 23505 → conflict", async () => {
    const rival = competitorTakesSlot("det-conflict", "Lives in Odesa");

    const res = await propose({ statement: "Lives in Kharkiv", slotKey: "det-conflict" });
    expect(res.state).toBe("conflict");
    if (res.state !== "conflict") throw new Error("unreachable");

    const cand = await candRow(res.candidateId);
    expect(cand.conflicts_with).toBe(rival);
    expect(cand.resolved_at).toBeNull();
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
  });

  it("user_direct activates: the claim is confirmed, filed under the default topic, the candidate closed", async () => {
    const res = await propose({
      statement: "Favourite coffee — filter",
      slotKey: "coffee",
      value: { drink: "filter" },
      evidence: [{ messageId: `${P}msg`, quoteSnapshot: "coffee — filter" }],
    });

    expect(res.state).toBe("auto_active");
    if (res.state !== "auto_active") throw new Error("unreachable");
    expect(res.revision).toBe(1);

    const claim = await claimRow(res.claimId);
    expect(claim.statement).toBe("Favourite coffee — filter");
    expect(claim.slot_key).toBe("coffee");
    expect(claim.value).toEqual({ drink: "filter" });
    expect(claim.origin).toEqual({ kind: "user_direct", messageId: `${P}msg` });
    // Task 8's contract: the manifest lists only confirmed claims — `unverified`
    // would make a just-saved fact invisible while the move looked fine.
    expect(claim.review_status).toBe("confirmed");
    expect(claim.superseded_at).toBeNull();

    // Task 10's contract: the GET projects the topic — a claim with no topic is
    // equally invisible.
    expect(await inDefaultTopic(res.claimId)).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [res.claimId])).toBe(1);

    const [cand] = (await q(`SELECT * FROM memory_candidates WHERE space_id = $1`, [SPACE_A])).rows as {
      policy_state: string;
      claim_id: string | null;
      resolved_at: Date | null;
    }[];
    expect(cand.policy_state).toBe("auto_active");
    expect(cand.claim_id).toBe(res.claimId);
    expect(cand.resolved_at).not.toBeNull();

    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.propose'", [SPACE_A])).toBe(1);
    expect(await count("audit_events", "space_id = $1 AND action = 'claim.create'", [SPACE_A])).toBe(1);
  });

  it("an explicit topicNoteId is honoured instead of the default topic", async () => {
    const res = await propose({ statement: "a fact in its own topic", topicNoteId: NOTE_A });
    if (res.state !== "auto_active") throw new Error("expected auto_active");

    expect(await count("note_claims", "note_id = $1 AND claim_id = $2", [NOTE_A, res.claimId])).toBe(1);
    expect(await inDefaultTopic(res.claimId)).toBe(0);
    // The default topic was never even created.
    expect(await count("vault_notes", "space_id = $1 AND title = 'General'", [SPACE_A])).toBe(0);
  });

  it("sensitive → pending: no claim, the evidence waits in jsonb", async () => {
    const res = await propose({
      statement: "Salary — 100500",
      sensitive: true,
      evidence: [{ messageId: `${P}msg`, quoteSnapshot: "salary" }],
    });

    expect(res.state).toBe("pending");
    if (res.state !== "pending") throw new Error("unreachable");
    const cand = await candRow(res.candidateId);
    expect(cand.policy_state).toBe("pending");
    expect(cand.claim_id).toBeNull();
    expect(cand.resolved_at).toBeNull();
    expect(cand.sensitive).toBe(true);
    expect(cand.evidence).toEqual([{ messageId: `${P}msg`, quoteSnapshot: "salary" }]);
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(0);
  });

  it("any kind other than user_direct → pending", async () => {
    const kinds: Provenance["kind"][] = ["derived", "tool", "file", "web", "legacy_memory_doc"];
    for (const kind of kinds) {
      const res = await propose({ statement: `a fact from ${kind}`, provenance: { kind } });
      expect([kind, res.state]).toEqual([kind, "pending"]);
    }
    // None of them created a claim — this is what catches injection through a tool.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(0);
    expect(await count("memory_candidates", "space_id = $1 AND resolved_at IS NULL", [SPACE_A])).toBe(kinds.length);
  });

  it("forceState:'conflict' overrides even user_direct", async () => {
    const res = await propose({ statement: "contested", slotKey: "slot-x", forceState: "conflict" });
    expect(res.state).toBe("conflict");
    if (res.state !== "conflict") throw new Error("unreachable");
    const cand = await candRow(res.candidateId);
    expect(cand.policy_state).toBe("conflict");
    expect(cand.resolved_at).toBeNull();
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(0);
  });

  it("the same idempotencyKey is a COMPLETE no-op: no row, no event", async () => {
    const key = `${P}idem-fixed`;
    const first = await propose({ idempotencyKey: key, statement: "a fact, once" });
    expect(first.state).toBe("auto_active");

    const before = {
      cands: await count("memory_candidates", "space_id = $1", [SPACE_A]),
      claims: await count("vault_claims", "space_id = $1", [SPACE_A]),
      audit: await count("audit_events", "space_id = $1", [SPACE_A]),
    };

    // Different text under the same key: the answer is still "already handled".
    const again = await propose({ idempotencyKey: key, statement: "an entirely different fact" });
    expect(again).toEqual({ state: "duplicate" });

    expect(await count("memory_candidates", "space_id = $1", [SPACE_A])).toBe(before.cands);
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(before.claims);
    expect(await count("audit_events", "space_id = $1", [SPACE_A])).toBe(before.audit);
  });

  it("taken slot + the same text (different case/spacing) → merged, candidate CLOSED", async () => {
    const first = await propose({ statement: "Works in Kyiv", slotKey: "city" });
    if (first.state !== "auto_active") throw new Error("expected auto_active");

    const res = await propose({
      statement: "  works   in   kyiv ",
      slotKey: "city",
      evidence: [{ messageId: `${P}msg2`, quoteSnapshot: "in Kyiv" }],
    });
    expect(res).toEqual({ state: "merged", claimId: first.claimId });

    // No new claim was created; the evidence was added to the existing head.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [first.claimId])).toBe(1);

    // The candidate does not linger in the queue asking to confirm a known fact.
    const { rows } = await pool.query<{ policy_state: string; claim_id: string | null; resolved_at: Date | null }>(
      `SELECT * FROM memory_candidates WHERE space_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [SPACE_A],
    );
    expect(rows[0].policy_state).toBe("auto_active");
    expect(rows[0].claim_id).toBe(first.claimId);
    expect(rows[0].resolved_at).not.toBeNull();
    expect(await count("memory_candidates", "space_id = $1 AND resolved_at IS NULL", [SPACE_A])).toBe(0);
  });

  it("slot_key:'' is an ABSENT slot, not a slot named ''", async () => {
    // `""` is non-NULL, i.e. a full participant in uniq_vclaims_active_slot, yet
    // falsy in JS. Without normalization the second propose would take the slotless
    // branch, insert the claim OUTSIDE the savepoint, and the 23505 would escape to
    // the caller. The model behind the Task 7 tool returns `slot_key: ""` as an
    // ordinary answer.
    const first = await propose({ statement: "Lives in Odesa", slotKey: "" });
    expect(first.state).toBe("auto_active");
    if (first.state !== "auto_active") throw new Error("unreachable");
    expect((await claimRow(first.claimId)).slot_key).toBeNull();

    // The second, with DIFFERENT text, must neither fail nor merge.
    const second = await propose({ statement: "Has a cat", slotKey: "   " });
    expect(second.state).toBe("auto_active");

    expect(await count("vault_claims", "space_id = $1 AND slot_key IS NULL", [SPACE_A])).toBe(2);
    expect(await count("memory_candidates", "space_id = $1 AND slot_key IS NOT NULL", [SPACE_A])).toBe(0);
  });

  it("confirming a candidate with slot_key:'' does not stick on try_again", async () => {
    // A row written BEFORE the normalization must be confirmable too: otherwise
    // confirm never reads the head, hits 23505 on every insert and returns
    // try_again FOREVER.
    const cand = `${P}legacy-empty-slot`;
    await q(
      `INSERT INTO memory_candidates (id, idempotency_key, space_id, statement, slot_key, provenance, policy_state)
       VALUES ($1, $1, $2, 'Inherited empty slot', '', '{"kind":"user_direct"}'::jsonb, 'pending')`,
      [cand, SPACE_A],
    );

    const res = await confirmCandidate({ candidateId: cand, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect((await claimRow(res.claimId)).slot_key).toBeNull();
  });

  it("taken slot + different text → conflict, pointing at the head", async () => {
    const first = await propose({ statement: "Works in Kyiv", slotKey: "city" });
    if (first.state !== "auto_active") throw new Error("expected auto_active");

    const res = await propose({ statement: "Works in Lviv", slotKey: "city" });
    expect(res.state).toBe("conflict");
    if (res.state !== "conflict") throw new Error("unreachable");

    const cand = await candRow(res.candidateId);
    expect(cand.policy_state).toBe("conflict");
    expect(cand.conflicts_with).toBe(first.claimId);
    expect(cand.claim_id).toBeNull();
    expect(cand.resolved_at).toBeNull();
    // The head is untouched: the decision is the human's.
    expect(await count("vault_claims", "space_id = $1 AND superseded_at IS NULL", [SPACE_A])).toBe(1);
  });

  it("taken slot + the same text but a DIFFERENT value → conflict, and the head keeps its value", async () => {
    // The defect this pins: a merge decided on the statement ALONE answers "already
    // known" and drops the structured value on the floor. The slot exists precisely
    // for facts whose value changes over time, so the value is the part that matters.
    const first = await propose({ statement: "Keep backups", slotKey: "retention", value: { days: 30 } });
    if (first.state !== "auto_active") throw new Error("expected auto_active");

    const res = await propose({ statement: "keep   backups", slotKey: "retention", value: { days: 60 } });
    expect(res.state).toBe("conflict");
    if (res.state !== "conflict") throw new Error("unreachable");

    const cand = await candRow(res.candidateId);
    expect(cand.conflicts_with).toBe(first.claimId);
    expect(cand.resolved_at).toBeNull();
    // The head is untouched — including its value, which a merge would have left
    // stale while reporting success.
    expect((await claimRow(first.claimId)).value).toEqual({ days: 30 });
    expect(await count("vault_claims", "space_id = $1 AND superseded_at IS NULL", [SPACE_A])).toBe(1);
  });

  it("the same text and the same value merge, whatever order the keys arrive in", async () => {
    const first = await propose({
      statement: "Keep backups",
      slotKey: "retention-same",
      value: { days: 30, tier: "cold" },
    });
    if (first.state !== "auto_active") throw new Error("expected auto_active");

    // jsonb does not preserve key order, so a comparison by serialized text would
    // split this fact in two the moment the model listed the keys the other way.
    const res = await propose({
      statement: "Keep backups",
      slotKey: "retention-same",
      value: { tier: "cold", days: 30 },
    });
    expect(res).toEqual({ state: "merged", claimId: first.claimId });
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
  });

  it("a candidate asserting NO value merges and leaves the head's value alone", async () => {
    // Absence is "no opinion", not "the value is now empty". Reading it as a
    // divergence would manufacture a conflict card out of a plain restatement — and,
    // on the confirm side, would clear the number outright.
    const first = await propose({ statement: "Keep backups", slotKey: "retention-silent", value: { days: 30 } });
    if (first.state !== "auto_active") throw new Error("expected auto_active");

    expect(await propose({ statement: "keep backups", slotKey: "retention-silent" })).toEqual({
      state: "merged",
      claimId: first.claimId,
    });
    expect((await claimRow(first.claimId)).value).toEqual({ days: 30 });
    expect((await claimRow(first.claimId)).revision).toBe(1);
  });

  it("WITHOUT a slot: the same text with a different value is a conflict, not a merge", async () => {
    // The slotless dedup drops the value just as silently; the rule cannot depend on
    // whether a slot happens to be set, or the same fact merges or conflicts by
    // accident of the model's phrasing.
    const first = await propose({ statement: "Backups are kept", value: { days: 30 } });
    if (first.state !== "auto_active") throw new Error("expected auto_active");

    const res = await propose({ statement: "backups are kept", value: { days: 60 } });
    expect(res.state).toBe("conflict");
    if (res.state !== "conflict") throw new Error("unreachable");
    expect((await candRow(res.candidateId)).conflicts_with).toBe(first.claimId);
    expect((await claimRow(first.claimId)).value).toEqual({ days: 30 });
  });

  it("WITHOUT a slot: dedup by normalized text across the space's heads", async () => {
    const first = await propose({ statement: "Has a cat named Murchyk" });
    if (first.state !== "auto_active") throw new Error("expected auto_active");

    const dup = await propose({ statement: "has  a cat   NAMED Murchyk  " });
    expect(dup).toEqual({ state: "merged", claimId: first.claimId });

    const other = await propose({ statement: "Has a dog" });
    expect(other.state).toBe("auto_active");
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(2);
  });

  it("merged CONFIRMS the head: what the user said themselves does not stay unverified", async () => {
    // A head from the future legacy memory-doc migration: unverified and outside the
    // Task 8 manifest. The user states it outright; a merge without confirmation
    // would answer "merged" while the fact stayed invisible.
    const stale = await createClaim(
      {
        spaceId: SPACE_A,
        statement: "Has a cat named Murchyk",
        origin: { kind: "legacy_memory_doc" },
        reviewStatus: "unverified",
      },
      ACTOR,
    );

    expect(await propose({ statement: "has a cat named murchyk" })).toEqual({ state: "merged", claimId: stale.id });
    expect((await claimRow(stale.id)).review_status).toBe("confirmed");
    // A confirmation is not a new version: the content did not change.
    expect((await claimRow(stale.id)).revision).toBe(1);
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
  });

  it("RACE between two proposes on a FREE slot (same text): one active, one merged", async () => {
    const attempt = (key: string) =>
      propose({ idempotencyKey: `${P}race-${key}`, statement: "Lives in Odesa", slotKey: "race-slot" });

    // No queueing: both transactions start at once and are serialized solely by the
    // slot's partial unique index.
    const settled = await Promise.allSettled([attempt("a"), attempt("b")]);
    // No unique violation escapes — that is the whole point of the SAVEPOINT.
    expect(settled.map((s) => (s.status === "rejected" ? String(s.reason) : "fulfilled"))).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    const states = settled
      .flatMap((s) => (s.status === "fulfilled" ? [s.value] : []))
      .map((r) => r.state)
      .sort();
    expect(states).toEqual(["auto_active", "merged"]);

    // Exactly one active head in the slot — counted from the DATABASE, not from the
    // returned values.
    expect(await count("vault_claims", "space_id = $1 AND slot_key = 'race-slot' AND superseded_at IS NULL", [SPACE_A])).toBe(1);
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    // Both candidates are closed: neither is left hanging in the queue.
    expect(await count("memory_candidates", "space_id = $1 AND resolved_at IS NULL", [SPACE_A])).toBe(0);
  });

  it("RACE between two proposes on a FREE slot (different text): one active, one conflict", async () => {
    const attempt = (key: string, statement: string) =>
      propose({ idempotencyKey: `${P}race2-${key}`, statement, slotKey: "race-slot2" });

    const settled = await Promise.allSettled([attempt("a", "Lives in Odesa"), attempt("b", "Lives in Kharkiv")]);
    expect(settled.map((s) => (s.status === "rejected" ? String(s.reason) : "fulfilled"))).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    expect(results.map((r) => r.state).sort()).toEqual(["auto_active", "conflict"]);

    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    // The loser stays open and points at the winner.
    const { rows } = await pool.query<{ conflicts_with: string | null }>(
      `SELECT conflicts_with FROM memory_candidates WHERE space_id = $1 AND policy_state = 'conflict'`,
      [SPACE_A],
    );
    expect(rows).toHaveLength(1);
    const { rows: heads } = await pool.query<{ id: string }>(
      `SELECT id FROM vault_claims WHERE space_id = $1 AND superseded_at IS NULL`,
      [SPACE_A],
    );
    expect(rows[0].conflicts_with).toBe(heads[0].id);
  });

  it("a FOREIGN 23505 is not swallowed: another constraint escapes and the transaction rolls back", async () => {
    // Drizzle >=0.36 wraps the driver error — code and constraint are read off
    // `cause`. This is where the check on BOTH fields, not just the code, is proven.
    const boom = Object.assign(new Error("wrapped"), {
      cause: Object.assign(new Error("pg"), { code: "23505", constraint: "uniq_vclaims_one_successor" }),
    });
    ctl.createError = boom;

    await expect(propose({ statement: "must not survive", slotKey: "foreign" })).rejects.toBe(boom);

    // The outer transaction rolled back ENTIRELY: there is no candidate row, so the
    // idempotency key is not burned and the proposal can be retried.
    expect(await count("memory_candidates", "space_id = $1", [SPACE_A])).toBe(0);
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(0);
    expect(await count("audit_events", "space_id = $1", [SPACE_A])).toBe(0);
  });

  it("confirming an empty slot: claim confirmed, filed under the default topic, stored evidence applied", async () => {
    const proposed = await propose({
      statement: "Deadline — Monday",
      slotKey: "deadline",
      value: { day: "mon" },
      sensitive: true,
      evidence: [{ messageId: `${P}msg`, quoteSnapshot: "Monday" }, { relation: "derived_from" }],
    });
    if (proposed.state !== "pending") throw new Error("expected pending");

    const res = await confirmCandidate({ candidateId: proposed.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const claim = await claimRow(res.claimId);
    expect(claim.statement).toBe("Deadline — Monday");
    expect(claim.slot_key).toBe("deadline");
    expect(claim.value).toEqual({ day: "mon" });
    expect(claim.review_status).toBe("confirmed");
    // The candidate's sensitivity moves onto the claim rather than being lost.
    expect(claim.sensitive).toBe(true);
    expect(await inDefaultTopic(res.claimId)).toBe(1);
    // Both pieces of evidence from the jsonb are applied.
    expect(await count("claim_evidence", "claim_id = $1", [res.claimId])).toBe(2);

    const cand = await candRow(proposed.candidateId);
    expect(cand.claim_id).toBe(res.claimId);
    expect(cand.resolved_at).not.toBeNull();
    // policy_state stays as it was — the transition is recorded by the audit event.
    expect(cand.policy_state).toBe("pending");
    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.confirm'", [SPACE_A])).toBe(1);
  });

  it("confirm on a taken slot with the same text → merge into the head, and the head becomes confirmed", async () => {
    // The head is deliberately unverified and non-sensitive: the HUMAN's decision has
    // to raise both fields, or {ok:true} is returned for a fact nobody can see.
    const head = await createClaim(
      {
        spaceId: SPACE_A,
        statement: "Works in Kyiv",
        slotKey: "city",
        origin: { kind: "legacy_memory_doc" },
        reviewStatus: "unverified",
      },
      ACTOR,
    );

    const pending = await propose({
      statement: "works in kyiv",
      slotKey: "city",
      sensitive: true,
      evidence: [{ messageId: `${P}msg3` }],
    });
    if (pending.state !== "pending") throw new Error("expected pending");

    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res).toEqual({ ok: true, claimId: head.id });
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [head.id])).toBe(1);

    const row = await claimRow(head.id);
    expect(row.review_status).toBe("confirmed");
    // The candidate's sensitivity raises the head's; a merge may never clear it.
    expect(row.sensitive).toBe(true);
    expect(row.revision).toBe(1); // a merge is not a new version
  });

  it("confirm on a taken slot with the same text but a different value SUPERSEDES the head", async () => {
    // The human already said yes to THIS candidate, so the divergent value is a
    // correction, not a conflict to hand back to them — but it still has to reach the
    // head, which a value-blind merge would never do.
    const head = await createClaim(
      {
        spaceId: SPACE_A,
        statement: "Keep backups",
        slotKey: "retention-confirm",
        value: { days: 30 },
        origin: { kind: "legacy_memory_doc" },
        reviewStatus: "unverified",
      },
      ACTOR,
    );

    const pending = await propose({
      statement: "keep backups",
      slotKey: "retention-confirm",
      value: { days: 60 },
      sensitive: true,
      evidence: [{ messageId: `${P}msg-val` }],
    });
    if (pending.state !== "pending") throw new Error("expected pending");

    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.claimId).not.toBe(head.id);

    const successor = await claimRow(res.claimId);
    expect(successor.value).toEqual({ days: 60 });
    expect(successor.revision).toBe(2);
    expect(successor.supersedes).toBe(head.id);
    expect(successor.review_status).toBe("confirmed");
    expect(successor.sensitive).toBe(true);
    expect((await claimRow(head.id)).superseded_at).not.toBeNull();
    expect(await count("vault_claims", "space_id = $1 AND superseded_at IS NULL", [SPACE_A])).toBe(1);
  });

  it("confirming a candidate with NO value never supersedes the head's value to null", async () => {
    // The dangerous shape, and the one extraction produces most often: same words,
    // same slot, no value_json. Provenance is `derived`, so the gate sends it to
    // pending and a human confirms it. Treating the absent value as a divergence
    // supersedes the head with `patch.value = null` — a NULL jsonb arrives as `null`,
    // which is NOT `undefined`, so `updateClaim` writes it instead of inheriting, and
    // revision 2 lands empty under a cheerful `{ok:true}`.
    const first = await propose({ statement: "Keep backups", slotKey: "retention-keep", value: { days: 30 } });
    if (first.state !== "auto_active") throw new Error("expected auto_active");

    const pending = await propose({
      statement: "keep   backups",
      slotKey: "retention-keep",
      provenance: { kind: "derived", messageId: `${P}msg` },
      evidence: [{ messageId: `${P}msg-keep` }],
    });
    if (pending.state !== "pending") throw new Error("expected pending");

    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    // A merge into the SAME row, not a new version: nothing about the fact changed.
    expect(res).toEqual({ ok: true, claimId: first.claimId });
    const row = await claimRow(first.claimId);
    expect(row.value).toEqual({ days: 30 });
    expect(row.revision).toBe(1);
    expect(row.superseded_at).toBeNull();
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
  });

  it("a supersede driven by NEW text carries the head's value forward when the candidate has none", async () => {
    // The same rule one branch down: the words changed, so this IS a supersede — but
    // the candidate still said nothing about the value, and the successor must not be
    // the place where it quietly disappears.
    const head = await createClaim(
      {
        spaceId: SPACE_A,
        statement: "Keep backups for a month",
        slotKey: "retention-carry",
        value: { days: 30 },
        origin: { kind: "legacy_memory_doc" },
        reviewStatus: "unverified",
      },
      ACTOR,
    );

    const pending = await propose({
      statement: "Keep backups for a while",
      slotKey: "retention-carry",
      sensitive: true,
    });
    if (pending.state !== "pending") throw new Error("expected pending");

    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const successor = await claimRow(res.claimId);
    expect(successor.statement).toBe("Keep backups for a while");
    expect(successor.revision).toBe(2);
    expect(successor.supersedes).toBe(head.id);
    expect(successor.value).toEqual({ days: 30 });
  });

  it("confirm WITHOUT a slot dedups by text instead of breeding a second head", async () => {
    // A sensitive fact went to pending; meanwhile the same text was activated by
    // another proposal. Without the dedup, confirming would produce a SECOND
    // byte-identical head, and the store would repeat itself to the human forever.
    const pending = await propose({ statement: "Has a pollen allergy", sensitive: true, evidence: [{ messageId: `${P}m` }] });
    if (pending.state !== "pending") throw new Error("expected pending");

    const active = await propose({ statement: "has   a POLLEN allergy " });
    if (active.state !== "auto_active") throw new Error("expected auto_active");

    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res).toEqual({ ok: true, claimId: active.claimId });
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    // The candidate's evidence was added to the existing head.
    expect(await count("claim_evidence", "claim_id = $1", [active.claimId])).toBe(1);
    // The candidate's sensitivity was raised onto a head that was not sensitive.
    expect((await claimRow(active.claimId)).sensitive).toBe(true);
  });

  it("confirm on a taken slot with different text: the old head is superseded, the new one active and confirmed", async () => {
    // The head is deliberately unverified, with FOREIGN provenance and NO topic: if
    // confirm inherited those three fields from the predecessor, the confirmed fact
    // would come out unverified (outside the Task 8 manifest), signed
    // legacy_memory_doc (though the user said the words) and attached to no topic at
    // all (outside the Task 10 GET).
    const old = await createClaim(
      {
        spaceId: SPACE_A,
        statement: "Works in Kyiv",
        slotKey: "city",
        origin: { kind: "legacy_memory_doc" },
        reviewStatus: "unverified",
      },
      ACTOR,
    );
    expect(await count("note_claims", "claim_id = $1", [old.id])).toBe(0);

    const pending = await propose({ statement: "Works in Lviv", slotKey: "city", value: { city: "Lviv" }, sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const prev = await claimRow(old.id);
    expect(prev.superseded_at).not.toBeNull();
    expect(prev.statement).toBe("Works in Kyiv");

    const next = await claimRow(res.claimId);
    expect(next.statement).toBe("Works in Lviv");
    expect(next.value).toEqual({ city: "Lviv" });
    expect(next.supersedes).toBe(old.id);
    expect(next.revision).toBe(2);
    expect(next.review_status).toBe("confirmed");
    expect(next.sensitive).toBe(true);
    // The provenance is the candidate's, NOT the predecessor's: the user said this.
    expect(next.origin).toEqual({ kind: "user_direct", messageId: `${P}msg` });
    // The predecessor was in no topic — the successor has to land in the default one,
    // or the confirmed fact is invisible to the Task 10 GET.
    expect(await inDefaultTopic(res.claimId)).toBe(1);
    expect(await count("vault_claims", "space_id = $1 AND slot_key = 'city' AND superseded_at IS NULL", [SPACE_A])).toBe(1);
  });

  it("supersede does NOT relocate a human-curated section into the default topic", async () => {
    // The mirror of the previous test: if the predecessor's attachment carried over,
    // the fallback topic does not fire — otherwise confirm would quietly move a fact
    // out of the topic a human chose.
    const old = await createClaim(
      { spaceId: SPACE_A, statement: "Works in Kyiv", slotKey: "city", origin: {}, reviewStatus: "confirmed", topicNoteId: NOTE_A },
      ACTOR,
    );
    const pending = await propose({ statement: "Works in Lviv", slotKey: "city", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    if (!res.ok) throw new Error("expected ok");

    expect(await count("note_claims", "note_id = $1 AND claim_id = $2", [NOTE_A, res.claimId])).toBe(1);
    expect(await inDefaultTopic(res.claimId)).toBe(0);
    expect(await count("note_claims", "claim_id = $1", [old.id])).toBe(0);
  });

  it("RACE confirm/confirm: exactly one ok, the other already_resolved", async () => {
    const pending = await propose({ statement: "a contested confirmation", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");
    const attempt = () =>
      confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });

    const settled = await Promise.allSettled([attempt(), attempt()]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "already_resolved" });
    // One claim, not two.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
  });

  it("RACE confirm/reject: one winner", async () => {
    const pending = await propose({ statement: "confirm versus reject", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    const settled = await Promise.allSettled([
      confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR }),
      rejectCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR }),
    ]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    const [conf, rej] = settled.map((s) => (s.status === "fulfilled" ? s.value : null));

    expect([conf?.ok, rej?.ok].filter(Boolean)).toHaveLength(1);
    // confirm won → there is a claim; reject won → there is none.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(conf?.ok ? 1 : 0);
    expect(
      await count("audit_events", "space_id = $1 AND action IN ('candidate.confirm','candidate.reject')", [SPACE_A]),
    ).toBe(1);
  });

  it("one CAS loss means one retry, and the retry wins", async () => {
    await createClaim(
      { spaceId: SPACE_A, statement: "the old head", slotKey: "city", origin: {}, reviewStatus: "confirmed" },
      ACTOR,
    );
    const pending = await propose({ statement: "the new head", slotKey: "city", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    ctl.casLosses = 1;
    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res.ok).toBe(true);
    expect(ctl.casLosses).toBe(0);
  });

  it("confirm: a competitor takes the slot mid-create → SAVEPOINT, re-read, merge", async () => {
    const pending = await propose({ statement: "Lives in Odesa", slotKey: "confirm-race", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");
    const rival = competitorTakesSlot("confirm-race", "lives in odesa");

    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    // A 23505 inside confirm does not reach the caller either: the second attempt sees
    // the competitor's head and merges into it.
    expect(res).toEqual({ ok: true, claimId: rival });
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
  });

  it("two CAS losses → try_again, and the candidate stays OPEN in the database", async () => {
    await createClaim(
      { spaceId: SPACE_A, statement: "the old head", slotKey: "city", origin: {}, reviewStatus: "confirmed" },
      ACTOR,
    );
    const pending = await propose({ statement: "the new head", slotKey: "city", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    ctl.casLosses = 2;
    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res).toEqual({ ok: false, reason: "try_again" });

    // The resolved_at that CAS step 1 set rolled back WITH the transaction — otherwise
    // the fact would quietly vanish from the review queue.
    const cand = await candRow(pending.candidateId);
    expect(cand.resolved_at).toBeNull();
    expect(cand.claim_id).toBeNull();
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.confirm'", [SPACE_A])).toBe(0);
  });

  it("confirm: another space and a non-existent id both yield not_found", async () => {
    const pending = await propose({ statement: "a fact from elsewhere", spaceId: SPACE_B, sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    expect(
      await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await confirmCandidate({ candidateId: `${P}missing`, allowedSpaceIds: [SPACE_A], actor: ACTOR })).toEqual({
      ok: false,
      reason: "not_found",
    });
    // The other space's candidate is untouched.
    expect((await candRow(pending.candidateId)).resolved_at).toBeNull();
  });

  it("reject: resolves once, writes the audit event, leaves other spaces alone", async () => {
    const pending = await propose({ statement: "not wanted", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    expect(await rejectCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR })).toEqual({ ok: true });
    const cand = await candRow(pending.candidateId);
    expect(cand.resolved_at).not.toBeNull();
    expect(cand.claim_id).toBeNull();
    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.reject'", [SPACE_A])).toBe(1);

    // A second reject resolves nothing and writes no second event.
    expect(await rejectCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR })).toEqual({ ok: false });
    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.reject'", [SPACE_A])).toBe(1);
    // Nor does another space.
    expect(await rejectCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_B], actor: ACTOR })).toEqual({ ok: false });
  });

  it("listOpenCandidates: unresolved only, and only from this space", async () => {
    const open = await propose({ statement: "waiting on a human", sensitive: true });
    if (open.state !== "pending") throw new Error("expected pending");
    const resolved = await propose({ statement: "already decided", sensitive: true });
    if (resolved.state !== "pending") throw new Error("expected pending");
    await rejectCandidate({ candidateId: resolved.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    await propose({ statement: "auto-activated" }); // resolved_at was set by the activation
    await propose({ statement: "in another space", spaceId: SPACE_B, sensitive: true });

    const rows = await listOpenCandidates(SPACE_A);
    expect(rows.map((r) => r.id)).toEqual([open.candidateId]);
    expect(rows[0].statement).toBe("waiting on a human");

    expect((await listOpenCandidates(SPACE_B)).map((r) => r.statement)).toEqual(["in another space"]);
  });

  it("a credential the user pasted THEMSELVES never auto-activates", async () => {
    // The attack the extraction-path-only screen missed: the user pastes the key and
    // says "remember it", so the statement is verbatim in their own turn — the MOST
    // permissive case the provenance filter has — and the caller (memory_propose)
    // sets no `sensitive`. With the screen standing only on the extraction path this
    // wrote a confirmed, non-sensitive head, which the manifest then carried into the
    // system prompt of every later turn.
    const res = await propose({
      statement: "my OpenAI key is sk-proj-AbCdEf0123456789ghijkl",
      provenance: DIRECT,
    });
    expect(res.state).toBe("pending");
    if (res.state !== "pending") throw new Error("unreachable");
    // Stored as sensitive, not dropped: a human keeps a curation trail, and nothing
    // re-injects it in the meantime because the manifest excludes sensitive claims.
    expect((await candRow(res.candidateId)).sensitive).toBe(true);
    // The point of the whole exercise: no head exists, so there is nothing to inject.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(0);
  });

  it("verifyDirectProvenance: a quote yes, an invention no, a 60% paraphrase yes", async () => {
    const turn = "The project deadline moves to next Monday, please warn the team";

    // A verbatim quote.
    expect(verifyDirectProvenance("The project deadline moves to next Monday", turn)).toBe(true);
    // Case does not matter.
    expect(verifyDirectProvenance("THE PROJECT DEADLINE MOVES TO NEXT MONDAY", turn)).toBe(true);
    // A tool's invention: the user never wrote this.
    expect(verifyDirectProvenance("The user sold their flat and relocated to Barcelona", turn)).toBe(false);
    // A paraphrase right on the line: 3 of 5 long words (project, deadline, moves) = 60% → yes.
    expect(verifyDirectProvenance("Project deadline moves over payment", turn)).toBe(true);
    // 2 of 5 (40%) — no longer.
    expect(verifyDirectProvenance("Deadline team halted over payment", turn)).toBe(false);
    // Nothing to check — no long words, so authorship cannot be established.
    expect(verifyDirectProvenance("me too", turn)).toBe(false);
  });
});
