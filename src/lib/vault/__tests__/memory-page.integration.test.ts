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
  const claim = await createClaim(
    { spaceId, statement, origin: { kind: "user_direct" }, reviewStatus: "confirmed",
      sensitive: opts.sensitive, topicNoteId: noteId },
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
    expect(fact.statement).toBe("Prefers metric units");
    expect(fact.source).toMatchObject({ kind: "chat", chatTitle: "Q2 report" });
  });

  it("says a fact with no evidence came from the old notes, not from a chat", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    await createClaim(
      { spaceId, statement: "Carried across", origin: { kind: "legacy_memory_doc" },
        reviewStatus: "confirmed", topicNoteId: noteId },
      { kind: "system" },
    );
    expect((await readMemoryPage(OWNER)).scopes[0].topics[0].facts[0].source).toEqual({ kind: "legacy" });
  });

  it("shows a sensitive fact as existing and withholds its text", async () => {
    await seedFact("Attends a support group", { sensitive: true });
    const fact = (await readMemoryPage(OWNER)).scopes[0].topics[0].facts[0];
    expect(fact.sensitive).toBe(true);
    expect(fact.statement).toBeNull();
    expect(fact.previous).toBeNull();
    expect(JSON.stringify(fact)).not.toContain("support group");
  });

  it("withholds the PREVIOUS version of a sensitive fact too", async () => {
    // The second half of the withholding rule, and the one a reader forgets: `previous`
    // is the same words one revision earlier, so a history disclosure would read out
    // exactly what `statement` refuses to.
    const { spaceId, claim } = await seedFact("Attends a support group on Tuesdays", { sensitive: true });
    await updateClaim({
      claimId: claim.id, expectedRevision: 1,
      patch: { statement: "Attends a support group on Thursdays", sensitive: true },
      allowedSpaceIds: [spaceId], actor: { kind: "user", id: OWNER },
    });
    const fact = (await readMemoryPage(OWNER)).scopes[0].topics[0].facts[0];
    expect(fact.sensitive).toBe(true);
    expect(fact.previous).toBeNull();
    expect(JSON.stringify(fact)).not.toContain("support group");
  });

  it("carries the version a fact replaced", async () => {
    const { spaceId, claim } = await seedFact("Works from the Kyiv office");
    await updateClaim({
      claimId: claim.id, expectedRevision: 1,
      patch: { statement: "Works from the Lviv office" },
      allowedSpaceIds: [spaceId], actor: { kind: "user", id: OWNER },
    });
    const fact = (await readMemoryPage(OWNER)).scopes[0].topics[0].facts[0];
    expect(fact.statement).toBe("Works from the Lviv office");
    expect(fact.previous?.statement).toBe("Works from the Kyiv office");
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
    expect(scope.pending.map((p) => p.statement)).toEqual(["Uses Linux as their main operating system"]);
    expect(scope.pending[0].state).toBe("pending");
  });

  it("does not show an unverified claim among the facts", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    await createClaim(
      { spaceId, statement: "Read off a web page", origin: { kind: "web" },
        reviewStatus: "unverified", topicNoteId: noteId },
      { kind: "agent" },
    );
    expect((await readMemoryPage(OWNER)).scopes[0].topics[0].facts).toHaveLength(0);
  });

  it("shows a waiting fact that is sensitive as existing, without its text", async () => {
    // The candidate half of the withholding rule. Written straight into the table
    // because the secret screen is what normally raises the flag, and this test is
    // about the PROJECTION's obligation once it is raised, not about the screen.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await q(
      `INSERT INTO memory_candidates (id, idempotency_key, space_id, statement, provenance, sensitive, policy_state)
       VALUES ($1, $1, $2, $3, '{"kind":"derived"}'::jsonb, true, 'pending')`,
      [`${P}sensitive-cand`, spaceId, "Recovery code 447192 for the shared mailbox"],
    );

    const scope = (await readMemoryPage(OWNER)).scopes[0];
    expect(scope.pending).toHaveLength(1);
    expect(scope.pending[0].sensitive).toBe(true);
    expect(scope.pending[0].statement).toBeNull();
    expect(JSON.stringify(scope.pending)).not.toContain("447192");
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
    await createClaim(
      { spaceId: `${P}space-drift`, statement: "Belongs to the other account", origin: { kind: "user_direct" },
        reviewStatus: "confirmed", topicNoteId: noteId },
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
    expect(mine.map((f) => f.statement)).toEqual(["The owner's own fact"]);
    expect(JSON.stringify(await readMemoryPage(OWNER))).not.toContain("Nobody else may read this");

    const theirs = (await readMemoryPage(STRANGER)).scopes.flatMap((s) => s.topics.flatMap((t) => t.facts));
    expect(theirs.map((f) => f.statement)).toEqual(["Nobody else may read this"]);
  });
});
