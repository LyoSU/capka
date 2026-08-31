import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * `/api/memory-docs` across the cutover. The route is the ONE surface where a user
 * can still see their memory while the new page is built, so what it must prove is
 * not "it returns JSON" but that memory never goes dark: a migrated scope projects
 * its claims, an unmigrated one still shows its own text, and neither shows another
 * user's anything.
 *
 * Runs against the real database because the interesting parts are all joins and
 * ownership filters — the two things a mocked `db` would simply agree with.
 */
import { pool } from "@/lib/db";
import { createClaim } from "../claims";
import { seedConfirmedClaim, testServerClass } from "./fixtures";
import { DEFAULT_TOPIC_KEY, getOrCreateSpace, getOrCreateTopicNote } from "../spaces";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Every fixture id carries this prefix; spaces are caught by owner_user_id, whose
 *  ids are not ours to choose. */
const P = "mdroute-";
const OWNER = `${P}owner`;
const STRANGER = `${P}stranger`;
const PROJ = `${P}proj`;
const STRANGER_PROJ = `${P}strangerproj`;

const { requireActive, requireRole } = vi.hoisted(() => ({ requireActive: vi.fn(), requireRole: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireActive, requireRole };
});

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

/** users.email is unique too, so the conflict target must stay untargeted — a
 *  leftover row with this email would otherwise raise 23505 inside `beforeAll`,
 *  which surfaces as skipped tests rather than as a failure. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'memory route test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

const mkProject = (id: string, userId: string) =>
  q(`INSERT INTO projects (id, user_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [id, userId, id]);

/** A legacy document. `migrated` decides which half of the move the scope is in —
 *  the whole point of the fallback. */
const mkDoc = async (id: string, userId: string, projectId: string | null, content: string, migrated: boolean) => {
  await q(
    `INSERT INTO memory_docs (id, user_id, project_id, content, migrated_at)
     VALUES ($1, $2, $3, $4, ${migrated ? "now()" : "NULL"})`,
    [id, userId, projectId, content],
  );
};

/** A head filed under the default topic — what the projection reads.
 *
 *  `reviewStatus` is a parameter and not a constant because the quarantine is only
 *  observable here: a web/tool-derived fact lands `unverified` and must NOT reach
 *  this page, which is the one surface where a human would read it as something the
 *  assistant knows. A fixture of confirmed claims alone cannot tell the filter apart
 *  from no filter. */
const mkClaim = async (
  spaceId: string,
  statement: string,
  reviewStatus: "confirmed" | "unverified" = "confirmed",
) => {
  const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
  const confirmed = reviewStatus === "confirmed";
  const input = {
    spaceId,
    statement,
    origin: { kind: "user_direct" },
    topicNoteId: noteId,
    // Follows the review status for the same reason the parameter exists: the
    // quarantine is what this file observes, so an unverified fixture must not also
    // claim a manifest-grade class.
    sourceClass: testServerClass(confirmed ? "owner_authored" : "agent_inferred"),
  };
  // Confirming is a separate write since the cutover: `createClaim` produces an
  // unverified claim and nothing else can. An "unverified" fixture is therefore simply
  // one nobody confirmed.
  if (confirmed) await seedConfirmedClaim(input, { kind: "user", id: OWNER });
  else await createClaim(input, { kind: "system" });
};

/** A CONFIRMED head the user marked sensitive — the case the manifest withholds from
 *  the model and this page was printing in full. Confirmed on purpose: an unverified
 *  one would be filtered by `onlyConfirmed` and prove nothing about sensitivity. */
const mkSensitiveClaim = async (spaceId: string, statement: string) => {
  const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);
  await seedConfirmedClaim(
    { spaceId, statement, origin: { kind: "user_direct" }, sensitive: true, topicNoteId: noteId,
      sourceClass: testServerClass("owner_authored") },
    { kind: "user", id: OWNER },
  );
};

type Body = { user: string; projects: { id: string; name: string; content: string }[] };

const get = async (): Promise<Body> => {
  const { GET } = await import("@/app/api/memory-docs/route");
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
};

const cleanup = async () => {
  await q(`DELETE FROM memory_docs WHERE id LIKE $1`, [`${P}%`]);
  // The space drags its topics, claims and attachments along with it.
  await q(`DELETE FROM spaces WHERE owner_user_id LIKE $1`, [`${P}%`]);
};

run("vault: /api/memory-docs projection", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await mkUser(STRANGER);
    await mkProject(PROJ, OWNER);
    await mkProject(STRANGER_PROJ, STRANGER);
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM projects WHERE id IN ($1, $2)`, [PROJ, STRANGER_PROJ]);
    await q(`DELETE FROM "user" WHERE id IN ($1, $2)`, [OWNER, STRANGER]);
  });

  beforeEach(async () => {
    await cleanup();
    requireActive.mockImplementation(() => Promise.resolve({ userId: OWNER, role: "user", status: "active" }));
    requireRole.mockImplementation(() => Promise.resolve({ userId: OWNER, role: "user", status: "active" }));
  });

  it("projects confirmed claims as bullets, for the user scope and a project scope", async () => {
    const userSpace = await getOrCreateSpace({ type: "user", refId: OWNER });
    const projectSpace = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });
    await mkClaim(userSpace, "works in procurement");
    await mkClaim(projectSpace, "ships on Fridays");

    const body = await get();
    expect(body.user).toContain("- works in procurement");
    expect(body.projects.find((p) => p.id === PROJ)?.content).toContain("- ships on Fridays");
  });

  it("quarantined (unverified) claims never reach the page, in either scope", async () => {
    // The quarantine exists so a fact the assistant merely DERIVED — from a web page
    // or a tool result — is not presented as something it knows until a human says
    // so. This page is where that promise becomes visible, so it is where the filter
    // has to be held: without it, the same rows render as plain bullets.
    const userSpace = await getOrCreateSpace({ type: "user", refId: OWNER });
    const projectSpace = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });
    await mkClaim(userSpace, "confirmed user fact");
    await mkClaim(userSpace, "quarantined user fact", "unverified");
    await mkClaim(projectSpace, "confirmed project fact");
    await mkClaim(projectSpace, "quarantined project fact", "unverified");

    const body = await get();
    expect(body.user).toBe("- confirmed user fact");
    expect(body.projects.find((p) => p.id === PROJ)?.content).toBe("- confirmed project fact");
    expect(JSON.stringify(body)).not.toContain("quarantined");
  });

  it("falls back to the legacy text while a document is still unmigrated", async () => {
    // Nothing has been carried across for this scope, so the document IS the memory.
    // The prompt manifest falls back on the very same column, so this is also what
    // keeps the screen and the model from disagreeing mid-migration.
    await mkDoc(`${P}d1`, OWNER, null, "- likes tea\n- based in Lviv", false);

    const body = await get();
    expect(body.user).toBe("- likes tea\n- based in Lviv");
  });

  it("stops showing the legacy text once the document is migrated, and shows the claims instead", async () => {
    // Both exist at once — which is the normal state right after a migration, since
    // the document row stays behind. Showing both would double every fact.
    await mkDoc(`${P}d2`, OWNER, null, "- likes tea", true);
    const userSpace = await getOrCreateSpace({ type: "user", refId: OWNER });
    await mkClaim(userSpace, "likes tea");

    const body = await get();
    expect(body.user).toBe("- likes tea");
  });

  it("shows claims AND an unmigrated document together, so nothing the model sees is hidden", async () => {
    // The divergence case: a fact recorded this session lands as a claim while the
    // document has not been carried across yet. The manifest renders both, so the
    // page must too — legacy-first precedence would hide the claim, and for a
    // document that fails `migrateOne` deterministically it would hide it forever.
    await mkDoc(`${P}d5`, OWNER, null, "- an old line still in the document", false);
    const userSpace = await getOrCreateSpace({ type: "user", refId: OWNER });
    await mkClaim(userSpace, "a fact recorded this session");

    const body = await get();
    expect(body.user).toContain("- a fact recorded this session");
    expect(body.user).toContain("- an old line still in the document");
    // Claims first, matching the manifest's order.
    expect(body.user.indexOf("this session")).toBeLessThan(body.user.indexOf("still in the document"));
  });

  it("never prints a confirmed SENSITIVE statement, in either scope", async () => {
    // The manifest already withholds these from the model. This page was the second
    // reader of the same invariant and did not, so a fact the user marked sensitive —
    // a diagnosis, a private-life detail — was correctly absent from the prompt and
    // then printed in full on the settings screen.
    const userSpace = await getOrCreateSpace({ type: "user", refId: OWNER });
    const projectSpace = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });
    await mkClaim(userSpace, "ordinary user fact");
    await mkSensitiveClaim(userSpace, "has a private medical condition");
    await mkClaim(projectSpace, "ordinary project fact");
    await mkSensitiveClaim(projectSpace, "a confidential project detail");

    const body = await get();
    expect(body.user).toBe("- ordinary user fact");
    expect(body.projects.find((p) => p.id === PROJ)?.content).toBe("- ordinary project fact");
    expect(JSON.stringify(body)).not.toContain("private medical");
    expect(JSON.stringify(body)).not.toContain("confidential project");
  });

  it("shows a document that was appended to AFTER its stamp (the reader shares notCarried)", async () => {
    // A rolling upgrade: the old instance appends after the new one stamped. The
    // migration treats that document as uncarried; a reader testing only
    // `migrated_at IS NULL` calls it done and the late bullet vanishes from this page
    // until some process happens to restart.
    await mkDoc(`${P}d6`, OWNER, null, "- carried already\n- appended after the stamp", true);
    await q(
      `UPDATE memory_docs SET migrated_at = now() - interval '2 hours', updated_at = now() - interval '1 hour'
        WHERE id = $1`,
      [`${P}d6`],
    );

    const body = await get();
    expect(body.user).toContain("- appended after the stamp");
  });

  it("never shows another user's project, memory or claims", async () => {
    const strangerSpace = await getOrCreateSpace({
      type: "project",
      refId: STRANGER_PROJ,
      ownerUserId: STRANGER,
    });
    await mkClaim(strangerSpace, "a secret about someone else");
    await mkDoc(`${P}d3`, STRANGER, null, "- the stranger's own memory", false);
    const strangerUserSpace = await getOrCreateSpace({ type: "user", refId: STRANGER });
    await mkClaim(strangerUserSpace, "another secret");

    const body = await get();
    expect(body.projects.map((p) => p.id)).not.toContain(STRANGER_PROJ);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("stranger's own memory");
  });

  it("PUT is fenced with 409 memory_moved and writes nothing", async () => {
    await mkDoc(`${P}d4`, OWNER, null, "- untouched", false);
    const { PUT } = await import("@/app/api/memory-docs/route");

    // No body is constructed: the handler refuses before reading one, which is the
    // point — there is no payload shape that can get past this.
    const res = await PUT();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "memory_moved" });

    // The fence is only worth anything if the write really did not happen: this is
    // half of what makes the migration selector safe to widen, since a PUT that
    // still landed would move `updated_at` and re-select the document forever.
    const { rows } = await q(`SELECT content FROM memory_docs WHERE id = $1`, [`${P}d4`]);
    expect((rows[0] as { content: string }).content).toBe("- untouched");
  });
});
