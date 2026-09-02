import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `PATCH /api/memory/notes/[noteId]` — the chat notice's Undo for a turn that EDITED a file
 * it did not create, and specifically the three status codes it maps to.
 *
 * WHY THIS IS ITS OWN SUITE. `revertNote` has an integration suite and `undoRequest` has a
 * unit one, and between them they cover everything except the translation this route
 * performs: `revision_moved` → 409 carrying the head, `not_revertable` and `not_found` →
 * 404, a body that is not a revision → 400. That mapping is the whole defect that made the
 * notice answer an edited file's Undo with a DELETE — a 409 collapsed into a 404 removes
 * the one control that can retry and reports success for a file it never changed — and an
 * edit that collapsed it again would leave every other suite green.
 *
 * The services are mocked because what is asserted here exists ONLY in this file: which
 * status a given `revertNote` outcome becomes, and that a malformed body never reaches the
 * writer at all.
 */
const { requireWriter, noteHead, revertNote } = vi.hoisted(() => ({
  requireWriter: vi.fn(),
  noteHead: vi.fn(),
  revertNote: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  // `apiHandler` stays REAL: it is what turns a thrown auth error into a status, and a
  // stubbed one would let this suite agree with a mapping the route no longer has.
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireWriter };
});
vi.mock("@/lib/vault/notes", () => ({
  noteHead,
  revertNote,
  // The other two verbs on this route file import them; unused here.
  forgetNote: vi.fn(),
  restoreNote: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => Promise.resolve([{ id: "space-1" }]) }) }) },
}));

import { PATCH } from "@/app/api/memory/notes/[noteId]/route";

const params = { params: Promise.resolve({ noteId: "note-1" }) };
const req = (body: unknown) =>
  new Request("http://x/api/memory/notes/note-1", { method: "PATCH", body: JSON.stringify(body) });

beforeEach(() => {
  requireWriter.mockReset().mockResolvedValue({ userId: "u1" });
  noteHead.mockReset().mockResolvedValue({ id: "note-1", spaceId: "space-1", revision: 2 });
  revertNote.mockReset();
});

describe("PATCH /api/memory/notes/[noteId]", () => {
  it("maps a lost or stale head to 409, carrying the revision it found", async () => {
    // THE ONE THAT MUST NOT BECOME A 404. The edit is still there, so the client has
    // something to do about it — and the number it needs is on the response.
    revertNote.mockResolvedValue({ ok: false, reason: "revision_moved", revision: 5 });
    const res = await PATCH(req({ revertTo: 1, expectedRevision: 2 }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "revision_moved", revision: 5 });
  });

  it("maps nothing-to-go-back-to and no-such-note to 404, with no revision on the body", async () => {
    // Telling these apart would make another user's note ids probeable one at a time. The
    // 409 above is not that, because it is only reachable for a note the ownership read
    // already admitted.
    for (const reason of ["not_revertable", "not_found"] as const) {
      revertNote.mockResolvedValue({ ok: false, reason });
      const res = await PATCH(req({ revertTo: 1, expectedRevision: 2 }), params);
      expect(res.status, reason).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("a note that vanished under the revert is a 404, never a 409 naming revision zero", async () => {
    // The narrow arm behind LOW-10(r2): `reviseNote` reports revision 0 when its post-CAS
    // re-read finds no row, which here means a concurrent wipe of the space's memory. The
    // guarantee is made in `revertNote` — it answers `not_found` rather than passing the zero
    // on — and this is the route's half of it: that outcome is a 404 the notice already knows
    // how to handle, and the body carries no revision for the client to retry with.
    revertNote.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await PATCH(req({ revertTo: 1, expectedRevision: 2 }), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("a note that is not yours is the same 404, and the writer is never called", async () => {
    noteHead.mockResolvedValue(null);
    const res = await PATCH(req({ revertTo: 1, expectedRevision: 2 }), params);
    expect(res.status).toBe(404);
    expect(revertNote).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a revision with 400, before anything is read", async () => {
    for (const body of [
      { revertTo: "1" },
      { revertTo: 0 },
      { revertTo: 1.5 },
      {},
      // The GUARD itself malformed. It is optional, so `undefined` passes — but a client
      // sending a broken one must not have it silently dropped and get the unguarded write
      // it was trying to avoid.
      { revertTo: 1, expectedRevision: "2" },
      { revertTo: 1, expectedRevision: 0 },
    ]) {
      const res = await PATCH(req(body), params);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect(revertNote).not.toHaveBeenCalled();
    expect(noteHead).not.toHaveBeenCalled();
  });

  it("passes the client's target and guard through, and answers a success with the new head", async () => {
    // The control: the mapping above is about failures, and a suite that only asserted
    // failures would pass with the whole success path deleted.
    revertNote.mockResolvedValue({ ok: true, revision: 4 });
    const res = await PATCH(req({ revertTo: 1, expectedRevision: 2 }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revision: 4 });
    expect(revertNote).toHaveBeenCalledWith(
      expect.objectContaining({
        noteId: "note-1",
        spaceId: "space-1",
        toRevision: 1,
        expectedRevision: 2,
        // `user`, never `agent`: a model that could undo its own edit would make the
        // notice's Undo a thing the agent can press.
        actor: { kind: "user", id: "u1" },
      }),
    );
  });

  it("omitting the optional guard is allowed and reaches the writer as undefined", async () => {
    revertNote.mockResolvedValue({ ok: true, revision: 4 });
    const res = await PATCH(req({ revertTo: 1 }), params);
    expect(res.status).toBe(200);
    expect(revertNote).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: undefined }));
  });
});
