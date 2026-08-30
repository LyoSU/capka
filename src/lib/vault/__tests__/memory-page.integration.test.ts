import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

/** Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 *  The projection is all joins and ownership filters — exactly what a mocked `db` would
 *  simply agree with. What it must prove: the three relations survive the read (topic
 *  grouping, provenance, version history), a sensitive fact arrives as an existence with
 *  no text, a pending candidate arrives separately from a confirmed fact, and nothing
 *  crosses a user boundary. */
import { pool } from "@/lib/db";
import { attachEvidence, createClaim, updateClaim } from "../claims";
import { seedConfirmedClaim } from "./fixtures";
import { proposeCandidate } from "../candidates";
import { DEFAULT_TOPIC_KEY, getOrCreateSpace, getOrCreateTopicNote } from "../spaces";
import { readMemoryPage } from "../memory-page";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const P = "mempage-";
const OWNER = `${P}owner`;
/** The boundary case: a second account whose facts must never appear in OWNER's page. */
const STRANGER = `${P}stranger`;
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'memory page test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );
const mkChat = (id: string, userId: string, title: string) =>
  q(`INSERT INTO chats (id, user_id, title, visibility) VALUES ($1, $2, $3, 'private')
     ON CONFLICT (id) DO NOTHING`, [id, userId, title]);
const mkMessage = (id: string, chatId: string) =>
  q(`INSERT INTO messages (id, chat_id, role, content, created_at)
     VALUES ($1, $2, 'user', 'test', now()) ON CONFLICT (id) DO NOTHING`, [id, chatId]);

const seedFact = async (statement: string, opts: { sensitive?: boolean; owner?: string } = {}) => {
  const owner = opts.owner ?? OWNER;
  const spaceId = await getOrCreateSpace({ type: "user", refId: owner });
  const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
  const claim = await seedConfirmedClaim(
    { spaceId, statement, origin: { kind: "user_direct" }, sensitive: opts.sensitive, topicNoteId: noteId },
    { kind: "user", id: owner },
  );
  return { spaceId, noteId, claim };
};

run("vault: memory page projection", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await mkUser(STRANGER);
  });
  beforeEach(() => q(`DELETE FROM spaces WHERE owner_user_id = ANY($1)`, [[OWNER, STRANGER]]));
  afterAll(async () => {
    await q(`DELETE FROM spaces WHERE owner_user_id = ANY($1)`, [[OWNER, STRANGER]]);
    await q(`DELETE FROM messages WHERE id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM chats WHERE id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM projects WHERE id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM "user" WHERE id LIKE $1`, [`${P}%`]);
  });

  it("names the conversation a fact came from", async () => {
    const { claim } = await seedFact("Prefers metric units");
    await mkChat(`${P}chat`, OWNER, "Q2 report");
    await mkMessage(`${P}msg`, `${P}chat`);
    await attachEvidence(claim.id, { messageId: `${P}msg` });

    const fact = (await readMemoryPage(OWNER)).scopes[0].topics[0].facts[0];
    expect(fact.statement.text).toBe("Prefers metric units");
    expect(fact.source).toMatchObject({ kind: "chat", chatTitle: "Q2 report" });
  });

  it("says a fact with no evidence came from the old notes, not from a chat", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    await seedConfirmedClaim(
      { spaceId, statement: "Carried across", origin: { kind: "legacy_memory_doc" }, topicNoteId: noteId },
      { kind: "system" },
    );
    expect((await readMemoryPage(OWNER)).scopes[0].topics[0].facts[0].source).toEqual({ kind: "legacy" });
  });

  it("shows the OWNER a sensitive fact in full, marked", async () => {
    // `sensitive` withholds from the MODEL — the manifest and `memory_search` are the
    // readers that enforce that, and they are untouched. This surface answers a
    // different question: it is the owner of the space looking at their own memory, and
    // a fact they cannot read is one they cannot delete, correct or judge. The mark is
    // what the page blurs on; the withholding is not the server's to do here.
    await seedFact("Attends a support group", { sensitive: true });
    const fact = (await readMemoryPage(OWNER)).scopes[0].topics[0].facts[0];
    expect(fact.statement).toEqual({ text: "Attends a support group", sensitive: true });
  });

  it("shows the PREVIOUS version of a sensitive fact too", async () => {
    // The second half of the same rule. `previous` is the same words one revision
    // earlier: withholding it while sending `statement` would be an inconsistency, and
    // withholding both would hide the person's own history from them.
    const { spaceId, claim } = await seedFact("Attends a support group on Tuesdays", { sensitive: true });
    await updateClaim({
      claimId: claim.id, expectedRevision: 1,
      patch: { statement: "Attends a support group on Thursdays", sensitive: true },
      allowedSpaceIds: [spaceId], actor: { kind: "user", id: OWNER },
    });
    const fact = (await readMemoryPage(OWNER)).scopes[0].topics[0].facts[0];
    expect(fact.statement).toEqual({ text: "Attends a support group on Thursdays", sensitive: true });
    // The predecessor carries its OWN flag, not the successor's — `confirmClaim` raises
    // one in place with no supersede, so the two really can differ.
    expect(fact.previous?.statement).toEqual({ text: "Attends a support group on Tuesdays", sensitive: true });
  });

  it("a predecessor carries its OWN sensitivity, not the successor's", async () => {
    // The two are independent values and the projection reads both rows, rather than
    // stamping the head's flag onto its history. Asserted in the direction that is
    // actually reachable: `updateClaim` ORs the predecessor's flag into the successor, so
    // a sensitive predecessor cannot have a plain successor — but a PLAIN predecessor
    // acquiring a sensitive successor is ordinary (the correction is what introduced the
    // sensitive material), and stamping would then blur a version that was never marked.
    //
    // The direction that would EXPOSE something is not reachable through this chain
    // today; it is reachable for `conflictsWith`, which points at a different claim
    // entirely. Both go through `Statement` for that reason: an invariant that lives in
    // another module is the weaker kind of safe, and it is exactly the argument that made
    // the conflict line look safe when it was not.
    const { spaceId, claim } = await seedFact("Works from the Kyiv office");
    await updateClaim({
      claimId: claim.id, expectedRevision: 1,
      patch: { statement: "Works from the Kyiv office, desk by the safe", sensitive: true },
      allowedSpaceIds: [spaceId], actor: { kind: "user", id: OWNER },
    });
    const fact = (await readMemoryPage(OWNER)).scopes[0].topics[0].facts[0];
    expect(fact.statement.sensitive).toBe(true);
    expect(fact.previous?.statement).toEqual({ text: "Works from the Kyiv office", sensitive: false });
  });

  it("carries the version a fact replaced", async () => {
    const { spaceId, claim } = await seedFact("Works from the Kyiv office");
    await updateClaim({
      claimId: claim.id, expectedRevision: 1,
      patch: { statement: "Works from the Lviv office" },
      allowedSpaceIds: [spaceId], actor: { kind: "user", id: OWNER },
    });
    const fact = (await readMemoryPage(OWNER)).scopes[0].topics[0].facts[0];
    expect(fact.statement.text).toBe("Works from the Lviv office");
    expect(fact.previous?.statement.text).toBe("Works from the Kyiv office");
  });

  it("lists a waiting fact apart from the facts in use", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    const res = await proposeCandidate({
      idempotencyKey: `${P}pending`, spaceId,
      statement: "Uses Linux as their main operating system",
      provenance: { kind: "derived" },
    });
    expect(res.state).toBe("pending");

    const scope = (await readMemoryPage(OWNER)).scopes[0];
    expect(scope.topics.flatMap((t) => t.facts)).toHaveLength(0);
    expect(scope.pending.map((p) => p.statement.text)).toEqual(["Uses Linux as their main operating system"]);
    expect(scope.pending[0].state).toBe("pending");
  });

  it("does not show an unverified claim among the facts", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    // Left UNCONFIRMED, which since the cutover is simply what `createClaim` produces:
    // there is no field that could ask for anything else, and `confirmClaim` is not
    // called. That is the quarantine this assertion is about.
    await createClaim(
      { spaceId, statement: "Read off a web page", origin: { kind: "web" }, topicNoteId: noteId },
      { kind: "agent" },
    );
    expect((await readMemoryPage(OWNER)).scopes[0].topics[0].facts).toHaveLength(0);
  });

  it("shows a waiting fact that is sensitive in full, marked", async () => {
    // The candidate half, and the one where withholding was not merely inconsistent but
    // incoherent: this row carries Keep and Discard controls, so a blank statement asks
    // the person to approve words the screen refuses to show them. Written straight into
    // the table because the secret screen is what normally raises the flag, and this test
    // is about the PROJECTION's obligation once it is raised, not about the screen.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await q(
      `INSERT INTO memory_candidates (id, idempotency_key, space_id, statement, provenance, sensitive, policy_state)
       VALUES ($1, $1, $2, $3, '{"kind":"derived"}'::jsonb, true, 'pending')`,
      [`${P}sensitive-cand`, spaceId, "Recovery code 447192 for the shared mailbox"],
    );

    const scope = (await readMemoryPage(OWNER)).scopes[0];
    expect(scope.pending).toHaveLength(1);
    expect(scope.pending[0].statement).toEqual({
      text: "Recovery code 447192 for the shared mailbox",
      sensitive: true,
    });
  });

  it("a conflict carries the head it is contested against", async () => {
    // Amendment D. `conflict` on its own is a word, not a choice: keeping this candidate
    // SUPERSEDES that head, and a person cannot weigh that against a fact the page never
    // showed them. Seeded through the real ledger, because `conflicts_with` is written by
    // the policy and a hand-set column would be testing the test's own assumption.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    await seedConfirmedClaim(
      { spaceId, statement: "Works as a technical lead", slotKey: "person/role",
        origin: { kind: "user_direct" }, topicNoteId: noteId },
      { kind: "user", id: OWNER },
    );
    const head = (await readMemoryPage(OWNER)).scopes[0].topics[0].facts[0];
    const res = await proposeCandidate({
      idempotencyKey: `${P}conflict`, spaceId,
      statement: "Works as a lead cloud architect",
      slotKey: "person/role",
      provenance: { kind: "user_direct" },
      // NAMED, because since the authority cutover the ledger has no branch that decides
      // a conflict for itself: a slot no longer confers identity, so a proposal sharing
      // one is not evidence of disagreement. A correction is a conflict because its
      // PRODUCER (`memory_update`) says which head it contests, and this is that call.
      forceConflict: { conflictsWith: head.id },
    });
    expect(res.state).toBe("conflict");

    const waiting = (await readMemoryPage(OWNER)).scopes[0].pending[0];
    expect(waiting.state).toBe("conflict");
    expect(waiting.conflictsWith?.statement.text).toBe("Works as a technical lead");
  });

  it("a conflict FORCED by a tool update names its head too, not just an extraction's", async () => {
    // The second producer of `conflict` state. `memory_update`'s double-CAS-loss path
    // reaches it through `forceConflict`, which is evaluated into the gate BEFORE the
    // insert and returns without ever running the `conflict()` branch that writes
    // `conflicts_with` — so this row used to render the bare word while the extraction's
    // conflict rendered the full sentence. Two producers, one rule, and only one of them
    // held it. Paired with the `tools.test.ts` assertion that `memory_update` passes the
    // id it lost to; this half proves the id survives to the screen.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    const head = await seedConfirmedClaim(
      { spaceId, statement: "The client pays in hryvnia", origin: { kind: "user_direct" }, topicNoteId: noteId },
      { kind: "user", id: OWNER },
    );
    const res = await proposeCandidate({
      idempotencyKey: `${P}forced`, spaceId,
      statement: "The client pays in dollars",
      provenance: { kind: "derived" },
      forceConflict: { conflictsWith: head.id },
    });
    expect(res.state).toBe("conflict");

    const waiting = (await readMemoryPage(OWNER)).scopes[0].pending[0];
    expect(waiting.state).toBe("conflict");
    expect(waiting.conflictsWith?.statement.text).toBe("The client pays in hryvnia");
  });

  it("a conflict never quotes a head the page itself refuses to list", async () => {
    // `conflict(head.id)` takes its head from `headBySlot`/`listHeadClaims`, neither of
    // which filters review status, while `topicsOf` lists only `confirmed`. Without the
    // same filter here the page says "keeping this replaces «…»" about quarantined
    // material it will not show anywhere else — the module's own quarantine rule, walked
    // past at the entrance Amendment D created.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    const quarantined = await createClaim(
      { spaceId, statement: "Read off a web page and never verified", origin: { kind: "web" }, topicNoteId: noteId },
      { kind: "agent" },
    );
    await proposeCandidate({
      idempotencyKey: `${P}quarantine`, spaceId,
      statement: "Something the user actually said",
      provenance: { kind: "derived" },
      forceConflict: { conflictsWith: quarantined.id },
    });

    const page = await readMemoryPage(OWNER);
    expect(page.scopes[0].pending[0].state).toBe("conflict");
    expect(page.scopes[0].pending[0].conflictsWith).toBeNull();
    expect(JSON.stringify(page)).not.toContain("never verified");
  });

  it("a plain waiting fact names nothing it conflicts with", async () => {
    // The control: a projection that always joined something would satisfy the test
    // above while telling every ordinary row it disagrees with a fact.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    await proposeCandidate({
      idempotencyKey: `${P}plain`, spaceId,
      statement: "Uses Linux as their main operating system",
      provenance: { kind: "derived" },
    });
    expect((await readMemoryPage(OWNER)).scopes[0].pending[0].conflictsWith).toBeNull();
  });

  it("never shows a space owned by someone else, even under this user's own project", async () => {
    // The `owner_user_id` filter, isolated. It looks redundant next to the `ref_id`
    // filter and is not: a user space's refId IS its owner, but a PROJECT space's is
    // the project, so a space row whose owner drifted from the project's would be
    // reached by ref alone. `getOrCreateSpace` refuses to create that divergence today
    // — this filter is what keeps a row that already holds it from being read out.
    await q(`INSERT INTO projects (id, user_id, name) VALUES ($1, $2, 'memory page test') ON CONFLICT DO NOTHING`, [
      `${P}proj`,
      OWNER,
    ]);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'project', $2, $3)`, [
      `${P}space-drift`,
      `${P}proj`,
      STRANGER,
    ]);
    const noteId = await getOrCreateTopicNote(`${P}space-drift`, DEFAULT_TOPIC_KEY);
    await seedConfirmedClaim(
      { spaceId: `${P}space-drift`, statement: "Belongs to the other account", origin: { kind: "user_direct" },
        topicNoteId: noteId },
      { kind: "user", id: STRANGER },
    );

    const page = await readMemoryPage(OWNER);
    expect(page.scopes.map((s) => s.scope)).toEqual(["user"]);
    expect(JSON.stringify(page)).not.toContain("Belongs to the other account");
  });

  it("never shows another account's memory", async () => {
    // The ownership filter is one `eq` in a WHERE clause, so it is exactly the kind of
    // line that survives a refactor by looking unimportant. Both directions are read:
    // the stranger's fact must be absent from OWNER's page AND present on their own,
    // or a projection that returns nothing at all would pass the first half.
    await seedFact("Nobody else may read this", { owner: STRANGER });
    await seedFact("The owner's own fact");

    const mine = (await readMemoryPage(OWNER)).scopes.flatMap((s) => s.topics.flatMap((t) => t.facts));
    expect(mine.map((f) => f.statement.text)).toEqual(["The owner's own fact"]);
    expect(JSON.stringify(await readMemoryPage(OWNER))).not.toContain("Nobody else may read this");

    const theirs = (await readMemoryPage(STRANGER)).scopes.flatMap((s) => s.topics.flatMap((t) => t.facts));
    expect(theirs.map((f) => f.statement.text)).toEqual(["Nobody else may read this"]);
  });
});
