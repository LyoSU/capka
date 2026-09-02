import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

/** Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 *  The projection is all joins and ownership filters — exactly what a mocked `db` would
 *  simply agree with. What it must prove: the relations survive the read (provenance,
 *  version history), a sensitive fact arrives in full and marked, EVERY live head is
 *  listed whatever its review status, each row carries the trust tag that tells the
 *  person's words from the assistant's, and nothing crosses a user boundary.
 *
 *  Since the page became a list of TOPIC FILES it must also prove what that shape can lose:
 *  a fact reaches the reader wherever it is filed, one filed under nothing has its own list
 *  rather than none, a topic's row says what its file opens with, and deleting a file does
 *  not take the facts filed under it. */
import { pool } from "@/lib/db";
import { attachEvidence, confirmClaim, createClaim, updateClaim } from "../claims";
import { seedConfirmedClaim, testServerClass } from "./fixtures";
import { proposeCandidate } from "../candidates";
import { createNote, forgetNote, restoreNote } from "../notes";
import { getOrCreateSpace } from "../spaces";
import { DEFAULT_TOPIC_KEY, getOrCreateTopicNote } from "../topics";
import {
  FACT_LIMIT, readConflicts, readMemoryPage, trustTagOf,
  type ScopeView, type TopicView,
} from "../memory-page";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const P = "mempage-";
const OWNER = `${P}owner`;
/** The boundary case: a second account whose facts must never appear in OWNER's page. */
const STRANGER = `${P}stranger`;
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

/** The node half of a subtype row. Raw fixtures write the subtype row directly, so they
 *  own the node row too — the composite FK is what turned "every subtype row has a node"
 *  from a convention into a constraint. */
const seedNode = (id: string, spaceId: string, kind: "claim" | "note" | "source") =>
  q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, spaceId, kind]);

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

const seedFact = async (
  statement: string,
  opts: { sensitive?: boolean; owner?: string; topicKey?: string } = {},
) => {
  const owner = opts.owner ?? OWNER;
  const spaceId = await getOrCreateSpace({ type: "user", refId: owner });
  const noteId = await getOrCreateTopicNote(spaceId, opts.topicKey ?? DEFAULT_TOPIC_KEY);
  const claim = await seedConfirmedClaim(
    { spaceId, statement, origin: { kind: "user_direct" }, sensitive: opts.sensitive, topicNoteId: noteId, sourceClass: testServerClass("owner_authored") },
    { kind: "user", id: owner },
  );
  return { spaceId, noteId, claim };
};

/** A supersede the way the PRODUCT performs one: `updateClaim` writes the successor and
 *  `confirmClaim` approves it. Two calls, and that is the point — a supersede carries no
 *  approval across, so the successor is born `unverified` and `confirmClaim` stays the
 *  only write that grants authority. A fixture stopping at `updateClaim` would build a
 *  head this page deliberately does not render, and then read as a projection bug. */
const seedSupersede = async (
  claimId: string,
  spaceId: string,
  patch: { statement: string; sensitive?: boolean },
) => {
  const actor = { kind: "user", id: OWNER } as const;
  const upd = await updateClaim({ claimId, expectedRevision: 1, patch, sourceClass: testServerClass("owner_authored"), allowedSpaceIds: [spaceId], actor });
  if (!upd.ok) throw new Error("fixture: the supersede lost its CAS");
  if (!(await confirmClaim(upd.id, patch.sensitive ?? false, actor))) {
    throw new Error(`fixture: successor ${upd.id} was not confirmable`);
  }
  return upd;
};

/**
 * EVERY FACT THE PAGE PUTS IN FRONT OF THE READER, wherever it is filed.
 *
 * The unit on the page is a topic FILE now, so a fact reaches a person inside one topic's
 * disclosure or in the `unfiled` list — and almost every assertion in this file is about a
 * fact reaching them AT ALL, not about which heading it arrived under. Folding the two
 * lists here rather than in the module is deliberate: the module keeps them apart because
 * they are drawn in different places, and a test that only ever looked at `topics` would
 * pass while `unfiled` silently stopped being sent.
 */
const allFacts = (scope: ScopeView) => [...scope.topics.flatMap((t) => t.facts), ...scope.unfiled];

const factTexts = async () =>
  allFacts((await readMemoryPage(OWNER)).scopes[0]).map((f) => f.statement.text);

/** One topic file by title, which is how every assertion below addresses one: a nanoid is
 *  not something a test can name, and the title is what the row shows. */
const topicNamed = (scope: ScopeView, title: string): TopicView => {
  const found = scope.topics.find((t) => t.title.text === title);
  if (!found) throw new Error(`no topic «${title}» among [${scope.topics.map((t) => t.title.text).join(", ")}]`);
  return found;
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

    const fact = allFacts((await readMemoryPage(OWNER)).scopes[0])[0];
    expect(fact.statement.text).toBe("Prefers metric units");
    expect(fact.source).toMatchObject({ kind: "chat", chatTitle: "Q2 report" });
  });

  it("says a fact with no evidence came from the old notes, not from a chat", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    await seedConfirmedClaim(
      { spaceId, statement: "Carried across", origin: { kind: "legacy_memory_doc" }, topicNoteId: noteId, sourceClass: testServerClass("legacy_confirmed") },
      { kind: "system" },
    );
    expect(allFacts((await readMemoryPage(OWNER)).scopes[0])[0].source).toEqual({ kind: "legacy" });
  });

  it("shows the OWNER a sensitive fact in full, marked", async () => {
    // `sensitive` withholds from the MODEL — the manifest and `memory_search` are the
    // readers that enforce that, and they are untouched. This surface answers a
    // different question: it is the owner of the space looking at their own memory, and
    // a fact they cannot read is one they cannot delete, correct or judge. The mark is
    // what the page blurs on; the withholding is not the server's to do here.
    await seedFact("Attends a support group", { sensitive: true });
    const fact = allFacts((await readMemoryPage(OWNER)).scopes[0])[0];
    expect(fact.statement).toEqual({ text: "Attends a support group", sensitive: true });
  });

  it("shows the PREVIOUS version of a sensitive fact too", async () => {
    // The second half of the same rule. `previous` is the same words one revision
    // earlier: withholding it while sending `statement` would be an inconsistency, and
    // withholding both would hide the person's own history from them.
    const { spaceId, claim } = await seedFact("Attends a support group on Tuesdays", { sensitive: true });
    await seedSupersede(claim.id, spaceId, { statement: "Attends a support group on Thursdays", sensitive: true });
    const fact = allFacts((await readMemoryPage(OWNER)).scopes[0])[0];
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
    await seedSupersede(claim.id, spaceId, {
      statement: "Works from the Kyiv office, desk by the safe",
      sensitive: true,
    });
    const fact = allFacts((await readMemoryPage(OWNER)).scopes[0])[0];
    expect(fact.statement.sensitive).toBe(true);
    expect(fact.previous?.statement).toEqual({ text: "Works from the Kyiv office", sensitive: false });
  });

  it("carries the version a fact replaced", async () => {
    const { spaceId, claim } = await seedFact("Works from the Kyiv office");
    await seedSupersede(claim.id, spaceId, { statement: "Works from the Lviv office" });
    const fact = allFacts((await readMemoryPage(OWNER)).scopes[0])[0];
    expect(fact.statement.text).toBe("Works from the Lviv office");
    expect(fact.previous?.statement.text).toBe("Works from the Kyiv office");
  });

  it("lists an archived suggestion apart from the facts in use", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    const res = await proposeCandidate({
      idempotencyKey: `${P}pending`, spaceId,
      statement: "Uses Linux as their main operating system",
      provenance: { kind: "derived" },
    });
    expect(res.state).toBe("pending");

    const scope = (await readMemoryPage(OWNER)).scopes[0];
    expect(allFacts(scope)).toHaveLength(0);
    expect(scope.archive.map((p) => p.statement.text)).toEqual(["Uses Linux as their main operating system"]);
    expect(scope.archive[0].state).toBe("pending");
  });

  it("renders unresolved candidates as a read-only archive with its own expiry date", async () => {
    // §11.8. Nothing writes `memory_candidates` any more, so these rows are leftovers on
    // a deadline: the page states the date from the day it appears, which is what keeps
    // the drop from being a surprise. The date is on the RESPONSE and not per row — the
    // archive expires as a table, in one release.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    await proposeCandidate({
      idempotencyKey: `${P}archived`, spaceId,
      statement: "Might prefer the Lviv office",
      provenance: { kind: "derived" },
    });

    const page = await readMemoryPage(OWNER);
    expect(page.scopes[0].archive.map((a) => a.statement.text)).toEqual(["Might prefer the Lviv office"]);
    // A real date, thirty days after the release, and the same one for every scope.
    expect(Number.isNaN(Date.parse(page.archiveExpiresAt))).toBe(false);
    expect(page.archiveExpiresAt).toBe((await readMemoryPage(OWNER)).archiveExpiresAt);
  });

  it("shows every live head, whatever its review_status (§11.9)", async () => {
    // THE REGRESSION THIS CLOSES: leaving the `review_status = 'confirmed'` filter in
    // place while slice 2 removes the confirmation gate makes every fact the agent writes
    // invisible on the only surface where a person can see, edit, undo or delete it — and
    // this release's own shipping copy would be false. Left UNCONFIRMED, which is simply
    // what `createClaim` produces: there is no field that could ask for anything else.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    const agentWritten = await createClaim(
      { spaceId, statement: "Prefers invoices as PDF", origin: { kind: "agent_inference" }, topicNoteId: noteId, sourceClass: testServerClass("agent_inferred") },
      { kind: "agent" },
    );
    const page = await readMemoryPage(OWNER);
    expect(allFacts(page.scopes[0]).map((f) => f.id)).toContain(agentWritten.id);
  });

  it("carries a trust tag on every row, derived from source_class", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    // One head per class the owner's own space can legally hold. `untrusted_derived` is
    // absent for a reason and not by omission: §4.5 step 3 refuses it for a user space,
    // so a fixture that wrote one here would be building a state the product cannot reach
    // — its two arms are covered by the `trustTagOf` unit assertions below instead.
    for (const [statement, cls] of [
      ["Told it in a chat", "user_direct"],
      ["Typed on this page", "owner_authored"],
      ["Worked out on its own", "agent_inferred"],
      ["Kept before the cutover", "legacy_confirmed"],
    ] as const) {
      await createClaim(
        { spaceId, statement, origin: { kind: "agent_inference" }, topicNoteId: noteId, sourceClass: testServerClass(cls) },
        { kind: "agent" },
      );
    }
    const facts = allFacts((await readMemoryPage(OWNER)).scopes[0]);
    expect(facts).toHaveLength(4);
    // EVERY row, not most of them: a tag missing from one row is the flattening §9.1
    // forbids, and it is invisible in a screenshot of the other three.
    expect(facts.every((f) => !!f.trust.kind)).toBe(true);
    const tagOf = (text: string) => facts.find((f) => f.statement.text === text)!.trust;
    expect(tagOf("Told it in a chat")).toEqual({ kind: "user_direct" });
    expect(tagOf("Typed on this page")).toEqual({ kind: "owner_authored" });
    expect(tagOf("Worked out on its own")).toEqual({ kind: "agent_inferred" });
    // A pre-cutover claim the person confirmed reads as something they told Capka,
    // because that is what it is — the two classes stay distinct in the column.
    expect(tagOf("Kept before the cutover")).toEqual({ kind: "user_direct" });
  });

  it("names the MEDIUM from provenance and the CLASS from source_class, never the other way", async () => {
    // §2.3's deviation, in one assertion: `untrusted_derived` is a TRUST TIER over all
    // non-user ingress, and what kind of ingress it was lives in `origin`. Reading the
    // medium off the class is the round-1 H2 hole (a fetched page fell outside every
    // poisoning bound because the class named a file); reading the class off the medium is
    // the same error mirrored. Both arms of one class, and the class is unchanged by
    // either.
    expect(trustTagOf("untrusted_derived", { kind: "retrieved", documentName: "Acme MSA.pdf" })).toEqual({
      kind: "untrusted_document",
      name: "Acme MSA.pdf",
    });
    expect(trustTagOf("untrusted_derived", { kind: "retrieved" })).toEqual({ kind: "untrusted_web" });
    // And the reverse direction: a document named in the origin of a TRUSTED row does not
    // demote it. The class decides the tag; provenance only ever fills in the medium.
    expect(trustTagOf("user_direct", { documentName: "Acme MSA.pdf" })).toEqual({ kind: "user_direct" });
  });

  it("still blurs a sensitive statement and never withholds it from the owner", async () => {
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
    expect(scope.archive).toHaveLength(1);
    // IN FULL AND MARKED — the text travels, and `sensitive: true` is what the page
    // blurs on. Withholding it from the OWNER is the mistake this module's docstring
    // exists to undo: `sensitive` withholds from the model, and a row this person
    // cannot read is one they cannot judge, correct or delete.
    expect(scope.archive[0].statement).toEqual({
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
        origin: { kind: "user_direct" }, topicNoteId: noteId, sourceClass: testServerClass("owner_authored") },
      { kind: "user", id: OWNER },
    );
    const head = allFacts((await readMemoryPage(OWNER)).scopes[0])[0];
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

    const waiting = (await readMemoryPage(OWNER)).scopes[0].archive[0];
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
      { spaceId, statement: "The client pays in hryvnia", origin: { kind: "user_direct" }, topicNoteId: noteId, sourceClass: testServerClass("owner_authored") },
      { kind: "user", id: OWNER },
    );
    const res = await proposeCandidate({
      idempotencyKey: `${P}forced`, spaceId,
      statement: "The client pays in dollars",
      provenance: { kind: "derived" },
      forceConflict: { conflictsWith: head.id },
    });
    expect(res.state).toBe("conflict");

    const waiting = (await readMemoryPage(OWNER)).scopes[0].archive[0];
    expect(waiting.state).toBe("conflict");
    expect(waiting.conflictsWith?.statement.text).toBe("The client pays in hryvnia");
  });

  it("an archived conflict names an unverified head, because nothing is refused any more", async () => {
    // THE FILTER THAT WENT, from the other side. This used to assert the opposite: the
    // archive was not allowed to say "keeping this replaces «…»" about a head `factsOf`
    // refused to list, so it carried the same `review_status = 'confirmed'` clause. With
    // the clause gone from both selects the head is listed, so quoting it is no longer a
    // reference to something invisible — and keeping the clause HERE while dropping it
    // there would be the two-readers-one-rule split this module is written against.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    const unverified = await createClaim(
      { spaceId, statement: "Read off a web page", origin: { kind: "agent_inference" }, topicNoteId: noteId, sourceClass: testServerClass("agent_inferred") },
      { kind: "agent" },
    );
    await proposeCandidate({
      idempotencyKey: `${P}quarantine`, spaceId,
      statement: "Something the user actually said",
      provenance: { kind: "derived" },
      forceConflict: { conflictsWith: unverified.id },
    });

    const page = await readMemoryPage(OWNER);
    expect(page.scopes[0].archive[0].state).toBe("conflict");
    expect(page.scopes[0].archive[0].conflictsWith?.statement.text).toBe("Read off a web page");
    // And it IS in the fact list, which is what makes the quote legible at all.
    expect(allFacts(page.scopes[0]).map((f) => f.id)).toContain(unverified.id);
  });

  it("readConflicts is the ONE reader of the conflict state, and returns BOTH statements", async () => {
    // §4.5 step 5 stores a correction it may not apply as a live row pointing at the fact
    // it contests. A person cannot choose between two facts against one they cannot see,
    // so the reader returns both halves with both trust tags — and there is exactly one
    // reader, because two with different predicates is a recorded near-miss here (the
    // confirm path read `policy_state` while the page read the evidence column, so a
    // person authorised a replacement and got a second contradicting head forever).
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    const target = await createClaim(
      { spaceId, statement: "Acme invoices are paid monthly", origin: { kind: "current_user_quote" }, topicNoteId: noteId, sourceClass: testServerClass("user_direct") },
      { kind: "agent" },
    );
    const contesting = await createClaim(
      { spaceId, statement: "Acme invoices are paid quarterly", origin: { kind: "agent_inference" }, topicNoteId: noteId, sourceClass: testServerClass("agent_inferred"), conflictsWith: target.id },
      { kind: "agent" },
    );

    const conflicts = await readConflicts(spaceId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].claim).toMatchObject({ id: contesting.id, trust: { kind: "agent_inferred" } });
    expect(conflicts[0].claim.statement.text).toBe("Acme invoices are paid quarterly");
    expect(conflicts[0].contested).toMatchObject({ id: target.id, trust: { kind: "user_direct" } });
    expect(conflicts[0].contested.statement.text).toBe("Acme invoices are paid monthly");
    // The same reader is what the page ships, so the card and the list cannot disagree.
    const page = await readMemoryPage(OWNER);
    expect(page.scopes[0].conflicts).toEqual(conflicts);
    // Both halves are ALSO live heads: nothing decides visibility on the owner's page, so
    // the card is a second view of them and not a filter over the list.
    expect(allFacts(page.scopes[0]).map((f) => f.id).sort()).toEqual([contesting.id, target.id].sort());
  });

  it("readConflicts drops a pointer whose target is no longer live", async () => {
    // The control: a reader that always joined something would satisfy the test above
    // while quoting a dead predecessor as the thing this would replace — which
    // misdescribes the choice being asked for.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    const target = await createClaim(
      { spaceId, statement: "Acme invoices are paid monthly", origin: { kind: "current_user_quote" }, topicNoteId: noteId, sourceClass: testServerClass("user_direct") },
      { kind: "agent" },
    );
    await createClaim(
      { spaceId, statement: "Acme invoices are paid quarterly", origin: { kind: "agent_inference" }, topicNoteId: noteId, sourceClass: testServerClass("agent_inferred"), conflictsWith: target.id },
      { kind: "agent" },
    );
    await q(`UPDATE vault_claims SET superseded_at = now() WHERE id = $1`, [target.id]);
    expect(await readConflicts(spaceId)).toEqual([]);
  });

  it("a plain archived suggestion names nothing it conflicts with", async () => {
    // The control: a projection that always joined something would satisfy the test
    // above while telling every ordinary row it disagrees with a fact.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    await proposeCandidate({
      idempotencyKey: `${P}plain`, spaceId,
      statement: "Uses Linux as their main operating system",
      provenance: { kind: "derived" },
    });
    expect((await readMemoryPage(OWNER)).scopes[0].archive[0].conflictsWith).toBeNull();
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
      { spaceId: `${P}space-drift`, statement: "Belongs to the other account", origin: { kind: "user_direct" }, sourceClass: testServerClass("owner_authored"),
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

    const mine = (await readMemoryPage(OWNER)).scopes.flatMap(allFacts);
    expect(mine.map((f) => f.statement.text)).toEqual(["The owner's own fact"]);
    expect(JSON.stringify(await readMemoryPage(OWNER))).not.toContain("Nobody else may read this");

    const theirs = (await readMemoryPage(STRANGER)).scopes.flatMap(allFacts);
    expect(theirs.map((f) => f.statement.text)).toEqual(["Nobody else may read this"]);
  });

  it("files each fact under the topic it belongs to, and every one reaches the reader", async () => {
    // THE SHAPE OF THE PAGE, in one assertion, and the regression it must not re-open. A
    // topic RAIL showing one topic at a time put 33 of this account's 51 facts on screen
    // and left 18 behind buttons nobody had reason to press. The fix is not "one flat
    // list" — the page leads with topic files now — so what has to hold is the weaker and
    // more useful property: every fact is inside exactly one file's disclosure, and the
    // union of the disclosures is the whole space.
    await seedFact("Sends the reports on Fridays");
    await seedFact("Works from the Lviv office", { topicKey: "work" });
    await seedFact("Prefers metric units", { topicKey: "preferences" });

    const scope = (await readMemoryPage(OWNER)).scopes[0];
    expect(allFacts(scope).map((f) => f.statement.text).sort()).toEqual([
      "Prefers metric units",
      "Sends the reports on Fridays",
      "Works from the Lviv office",
    ]);
    expect(scope.factsTotal).toBe(3);
    // …and under the right heading, which the flat union above cannot see. The titles are
    // the containers' own: `TOPIC_LABELS` names only `general`, so a container minted for
    // any other key is titled with the key itself — which is what the live account's
    // pre-cutover rows look like, and not something this page invents a label for.
    expect(topicNamed(scope, "General").facts.map((f) => f.statement.text)).toEqual(["Sends the reports on Fridays"]);
    expect(topicNamed(scope, "work").facts.map((f) => f.statement.text)).toEqual(["Works from the Lviv office"]);
    expect(topicNamed(scope, "preferences").facts.map((f) => f.statement.text)).toEqual(["Prefers metric units"]);
    expect(scope.unfiled).toEqual([]);
  });

  it("lists a fact that hangs off no topic note at all, in its own list", async () => {
    // §11.9 AT THE FILING SEAM, and it is not a theoretical arm: `runExtraction` and
    // `migrateMemoryDocs` both call `createClaim` with no `topicNoteId`, so an unattended
    // extraction produces exactly this row. A page whose top level is topics has to have
    // somewhere to put it, or "every fact the agent writes stays visible" becomes a
    // property of which writer happened to run.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await seedConfirmedClaim(
      { spaceId, statement: "Filed under nothing", origin: { kind: "user_direct" }, sourceClass: testServerClass("owner_authored") },
      { kind: "user", id: OWNER },
    );
    const scope = (await readMemoryPage(OWNER)).scopes[0];
    expect(scope.unfiled.map((f) => f.statement.text)).toEqual(["Filed under nothing"]);
    // The CONTROL: it is not ALSO reported under a topic. A membership read that fell back
    // to "everything" for a note with no rows would satisfy the assertion above.
    expect(scope.topics.flatMap((t) => t.facts)).toEqual([]);
  });

  it("groups the topic files by section, in the page's own order", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    // One file per section, deliberately named so that ALPHABETICAL order and SECTION
    // order disagree: a projection that only sorted by title would return them as
    // Alpha/Beta/Delta/Gamma and pass a weaker assertion.
    for (const [title, section] of [
      ["Gamma", "you"],
      ["Delta", "topic"],
      ["Beta", "area"],
      ["Alpha", "person"],
    ] as const) {
      await createNote(
        { spaceId, title, bodyMarkdown: "", section, sourceClass: testServerClass("owner_authored"), provenance: { kind: "test" } },
        undefined,
      );
    }
    const scope = (await readMemoryPage(OWNER)).scopes[0];
    expect(scope.topics.map((t) => [t.section, t.title.text])).toEqual([
      ["you", "Gamma"],
      ["topic", "Delta"],
      ["area", "Beta"],
      ["person", "Alpha"],
    ]);
  });

  it("sorts by title INSIDE a section", async () => {
    // The other half of the ordering, which the section test above cannot see: with one
    // file per section, any stable order passes it.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    for (const title of ["Zoning rules", "Airport runs", "Monthly close"]) {
      await createNote(
        { spaceId, title, bodyMarkdown: "", section: "area", sourceClass: testServerClass("owner_authored"), provenance: { kind: "test" } },
        undefined,
      );
    }
    const scope = (await readMemoryPage(OWNER)).scopes[0];
    expect(scope.topics.map((t) => t.title.text)).toEqual(["Airport runs", "Monthly close", "Zoning rules"]);
  });

  it("defaults a topic container's section to 'topic', so nothing is unsectioned", async () => {
    // `resolveTopic` mints a container while filing a fact and passes no section — the
    // column's NOT NULL default is what keeps the page from needing a fifth heading for
    // rows nobody chose a shelf for.
    await seedFact("Sends the reports on Fridays");
    expect(topicNamed((await readMemoryPage(OWNER)).scopes[0], "General").section).toBe("topic");
  });

  it("previews the first PARAGRAPH of a file, not its first heading", async () => {
    // The reference writes `Summary` and `Details` headings INSIDE the file's own content,
    // so the first line of almost every file the agent is steered to write is a heading. A
    // row whose second line reads "Summary" tells the reader nothing the title did not.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await createNote(
      {
        spaceId,
        title: "Reporting rhythm",
        bodyMarkdown: "## Summary\n\nReports go out on Fridays, **before** noon.\n\n## Details\n\n- Sent by Olena",
        sourceClass: testServerClass("owner_authored"),
        provenance: { kind: "test" },
      },
      undefined,
    );
    const topic = topicNamed((await readMemoryPage(OWNER)).scopes[0], "Reporting rhythm");
    expect(topic.preview.text).toBe("Reports go out on Fridays, before noon.");
    // The BODY is untouched — the preview is a projection for the row, not a rewrite of
    // the file, and the detail view renders the markdown it was given.
    expect(topic.body.text).toContain("## Summary");
  });

  it("has no preview at all for a file nothing has written into", async () => {
    // Today's five live topic containers are exactly this: a title, a `topic_key`, and an
    // empty body. The row then has one line, which is honest — a placeholder sentence
    // would be the page inventing content for a file that has none.
    await seedFact("Sends the reports on Fridays");
    expect(topicNamed((await readMemoryPage(OWNER)).scopes[0], "General").preview.text).toBe("");
  });

  it("tags a topic file with where its head revision came from", async () => {
    // The trust tag on a FILE, from the head revision's `source_class` and `provenance` —
    // the same two columns and the same one function the fact rows use. A file the agent
    // wrote out of a document must not read as something the person wrote, which is §9.1
    // one level up from a fact.
    const spaceId = await getOrCreateSpace({ type: "project", refId: `${P}proj-taint`, ownerUserId: OWNER });
    await q(`INSERT INTO projects (id, user_id, name) VALUES ($1, $2, 'taint') ON CONFLICT DO NOTHING`, [
      `${P}proj-taint`,
      OWNER,
    ]);
    // `untrusted_derived` is only reachable in a PROJECT space — §4.5 step 3 refuses it
    // for personal memory — so the fixture builds the state the product can actually
    // reach rather than one it cannot.
    await createNote(
      {
        spaceId,
        title: "Acme payment terms",
        bodyMarkdown: "Net 30 from the invoice date.",
        sourceClass: testServerClass("untrusted_derived"),
        provenance: { kind: "retrieved", documentName: "Acme MSA.pdf" },
        section: "area",
      },
      undefined,
    );
    await createNote(
      {
        spaceId,
        title: "Shipping window",
        bodyMarkdown: "Two weeks, per the supplier's site.",
        sourceClass: testServerClass("untrusted_derived"),
        provenance: { kind: "retrieved" },
      },
      undefined,
    );

    const project = (await readMemoryPage(OWNER)).scopes.find((s) => s.projectId === `${P}proj-taint`)!;
    expect(topicNamed(project, "Acme payment terms").trust).toEqual({
      kind: "untrusted_document",
      name: "Acme MSA.pdf",
    });
    // The MEDIUM comes off provenance and the CLASS off the column: one class, two arms.
    expect(topicNamed(project, "Shipping window").trust).toEqual({ kind: "untrusted_web" });
  });

  it("lists a project's topic files under that project", async () => {
    await q(`INSERT INTO projects (id, user_id, name) VALUES ($1, $2, 'Q3 launch') ON CONFLICT DO NOTHING`, [
      `${P}proj-list`,
      OWNER,
    ]);
    const projectSpace = await getOrCreateSpace({ type: "project", refId: `${P}proj-list`, ownerUserId: OWNER });
    await createNote(
      { spaceId: projectSpace, title: "Launch checklist", bodyMarkdown: "Freeze the copy on the 12th.", sourceClass: testServerClass("owner_authored"), provenance: { kind: "test" } },
      undefined,
    );
    await seedFact("Sends the reports on Fridays");

    const page = await readMemoryPage(OWNER);
    expect(page.scopes.map((s) => s.scope)).toEqual(["user", "project"]);
    const project = page.scopes[1];
    expect(project).toMatchObject({ projectId: `${P}proj-list`, projectName: "Q3 launch" });
    expect(project.topics.map((t) => t.title.text)).toEqual(["Launch checklist"]);
    // The CONTROL: the project's file is not also listed in personal memory, and the
    // personal topic is not listed under the project.
    expect(page.scopes[0].topics.map((t) => t.title.text)).toEqual(["General"]);
  });

  it("a DELETED topic file is gone and its facts are not", async () => {
    // The owner's delete removes the FILE. `deleteNode` deliberately leaves `note_claims`
    // alone — "forgetting a fact does not mean rewriting where it came from" — so the
    // facts that were filed under it are still the person's facts, and they must still be
    // deletable one by one. Without the `unfiled` list they would simply vanish with the
    // heading, which is a delete that silently destroys more than it says.
    const { spaceId, noteId } = await seedFact("Sends the reports on Fridays");
    const res = await forgetNote({
      noteId,
      spaceId,
      expectedRevision: 1,
      // NO `createdTaskId` — the owner's own delete, bounded by nobody's task.
      actor: { kind: "user", id: OWNER },
    });
    expect(res).toEqual({ ok: true });

    const scope = (await readMemoryPage(OWNER)).scopes[0];
    expect(scope.topics).toEqual([]);
    expect(scope.unfiled.map((f) => f.statement.text)).toEqual(["Sends the reports on Fridays"]);
    expect(scope.factsTotal).toBe(1);
  });

  it("an UNDONE delete puts the file back with its facts filed where they were", async () => {
    // The undo toast's promise, end to end. It is a real inverse rather than a friendlier
    // delete: the file is listed again, and the fact is back inside it rather than left in
    // the `unfiled` list the delete had moved it to.
    const { spaceId, noteId } = await seedFact("Sends the reports on Fridays");
    await forgetNote({ noteId, spaceId, expectedRevision: 1, actor: { kind: "user", id: OWNER } });
    expect(await restoreNote({ noteId, spaceId, actor: { kind: "user", id: OWNER } })).toEqual({ ok: true });

    const scope = (await readMemoryPage(OWNER)).scopes[0];
    expect(topicNamed(scope, "General").facts.map((f) => f.statement.text)).toEqual(["Sends the reports on Fridays"]);
    expect(scope.unfiled).toEqual([]);
    // AND the `contains` edge is open again. Not decoration: `containsParity` compares
    // `note_claims` against LIVE edges over LIVE nodes, so a restore that left the edges
    // closed would make the next `contains` write anywhere in this space throw.
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM vault_edges
        WHERE space_id = $1 AND relation = 'contains' AND deleted_at IS NULL`,
      [spaceId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("restoring a file nobody deleted is not an error", async () => {
    // An undo clicked twice, or in two tabs: the person wants the file back and it is
    // back. `not_found` covers it, and the route answers 404 — which is why this asserts
    // the reason rather than a throw.
    const { spaceId, noteId } = await seedFact("Sends the reports on Fridays");
    expect(await restoreNote({ noteId, spaceId, actor: { kind: "user", id: OWNER } })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("orders a topic's facts newest first", async () => {
    // Not alphabetical and not by topic: what changed lately is how a person notices a
    // wrong fact. Seeded oldest-first so a projection that simply preserved insertion
    // order would fail.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await seedNode(`${P}c-old`, spaceId, "claim");
    await seedNode(`${P}c-mid`, spaceId, "claim");
    await seedNode(`${P}c-new`, spaceId, "claim");
    await q(
      `INSERT INTO vault_claims (id, space_id, statement, origin, review_status, recorded_at, source_class)
       VALUES ($1, $4, 'Oldest', '{"kind":"user_direct"}'::jsonb, 'confirmed', now() - interval '2 days', 'legacy_confirmed'),
              ($2, $4, 'Middle', '{"kind":"user_direct"}'::jsonb, 'confirmed', now() - interval '1 day', 'legacy_confirmed'),
              ($3, $4, 'Newest', '{"kind":"user_direct"}'::jsonb, 'confirmed', now(), 'legacy_confirmed')`,
      [`${P}c-old`, `${P}c-mid`, `${P}c-new`, spaceId],
    );
    expect(await factTexts()).toEqual(["Newest", "Middle", "Oldest"]);
  });

  it("caps a topic's list and reports the count independently of it", async () => {
    // The shape has to survive 5000. The cap is PER TOPIC, so `factsTotal` on the topic is
    // counted off the membership and not off `facts.length` — a disclosure that said
    // "showing 200 of 200" is the sentence being wrong exactly where it matters.
    //
    // Written straight into the tables: this is about the projection's arithmetic at
    // scale, and two hundred round-trips through the ledger would be testing the ledger.
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
    const over = FACT_LIMIT + 5;
    // Set-based, like the inserts it feeds: a per-row round trip for FACT_LIMIT + 5 nodes
    // would be the very thing the comment above says this test avoids.
    await q(
      `INSERT INTO vault_nodes (id, space_id, kind)
       SELECT $1 || i, $2, 'claim' FROM generate_series(1, $3) AS i`,
      [`${P}bulk-`, spaceId, over],
    );
    await q(
      `INSERT INTO vault_claims (id, space_id, statement, origin, review_status, recorded_at, source_class)
       SELECT $1 || i, $2, 'Bulk fact ' || i, '{"kind":"user_direct"}'::jsonb, 'confirmed',
              now() - (i || ' seconds')::interval, 'legacy_confirmed'
         FROM generate_series(1, $3) AS i`,
      [`${P}bulk-`, spaceId, over],
    );
    // Filed, so the cap under test is the topic's and not the `unfiled` list's. The
    // `contains` edge is deliberately NOT written here: `assertContainsParity` fires on
    // `contains` WRITES, and this test performs none.
    await q(
      `INSERT INTO note_claims (note_id, claim_id)
       SELECT $1, $2 || i FROM generate_series(1, $3) AS i`,
      [noteId, `${P}bulk-`, over],
    );

    const topic = topicNamed((await readMemoryPage(OWNER)).scopes[0], "General");
    expect(topic.facts).toHaveLength(FACT_LIMIT);
    expect(topic.factsTotal).toBe(over);
    // …and the space's own count, which the "forget everything" dialog promises against,
    // is neither of those two numbers narrowed by a topic.
    expect((await readMemoryPage(OWNER)).scopes[0].factsTotal).toBe(over);
    // NEWEST FIRST inside the cap, which is what makes the dropped rows the old ones: the
    // fixture stamps `recorded_at` as `now() - i seconds`, so row 1 is the newest.
    expect(topic.facts[0].statement.text).toBe("Bulk fact 1");
  });
});
