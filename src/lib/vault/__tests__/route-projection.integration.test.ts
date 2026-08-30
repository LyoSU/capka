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
import { DEFAULT_TOPIC, getOrCreateSpace, getOrCreateTopicNote } from "../spaces";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Every fixture id carries this prefix; spaces are caught by owner_user_id, whose
 *  ids are not ours to choose. */
const P = "mdroute-";
const OWNER = `${P}owner`;
const STRANGER = `${P}stranger`;
const PROJ = `${P}proj`;
const STRANGER_PROJ = `${P}strangerproj`;

const { requireActive } = vi.hoisted(() => ({ requireActive: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireActive };
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

/** A confirmed head filed under the default topic — what the projection reads. */
const mkClaim = async (spaceId: string, statement: string) => {
  const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC);
  await createClaim(
    { spaceId, statement, origin: { kind: "user_direct" }, reviewStatus: "confirmed", topicNoteId: noteId },
    { kind: "system" },
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
