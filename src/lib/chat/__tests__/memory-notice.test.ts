import { describe, it, expect } from "vitest";
import type { TurnWrite } from "@/lib/vault/turn-writes";
import { DISMISSED_MAX, nextDismissed, noticeCounts, parseDismissed, undoRequest } from "../memory-notice";

/**
 * The dismissal store's two rules, tested where they can be: the component that reads them
 * is React and this suite runs with `environment: "node"`, which is why the logic sits
 * outside it (see the module docstring). What is NOT covered here, and is named rather
 * than implied: that the component actually calls these on mount and on click. The render
 * has no harness in this repo, so the seam is the smallest testable one — a pure list
 * transformation — and the wiring is one line at each end.
 */
describe("the memory notice's dismissal store", () => {
  it("is dismissible and does not reappear on the next turn", () => {
    // The whole property, as a round trip: dismiss, serialize, read back, and the notice
    // is still dismissed — which is what makes a later turn's reload leave it hidden
    // rather than bringing it back with the fresh snapshot.
    const after = nextDismissed(parseDismissed(null), "msg-1");
    expect(parseDismissed(JSON.stringify(after))).toContain("msg-1");
  });

  it("keeps one entry per message however often it is dismissed", () => {
    // Without the de-duplication the cap counts WRITES rather than notices, so a person
    // who dismissed the same one fifty times would evict every other dismissal.
    let list = parseDismissed(null);
    for (let i = 0; i < 5; i++) list = nextDismissed(list, "msg-1");
    expect(list).toEqual(["msg-1"]);
  });

  it("states its own bound and holds it", () => {
    // An uncapped list grows for the life of the browser profile and nothing trims it.
    let list: string[] = [];
    for (let i = 0; i < DISMISSED_MAX + 10; i++) list = nextDismissed(list, `msg-${i}`);
    expect(list).toHaveLength(DISMISSED_MAX);
    // Newest first, so what falls off is the oldest notice — one whose transcript is far
    // above the fold and which the person will not meet again.
    expect(list[0]).toBe(`msg-${DISMISSED_MAX + 9}`);
    expect(list).not.toContain("msg-0");
  });

  it("reads anything unusable as nothing dismissed, rather than throwing in a render", () => {
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed("not json")).toEqual([]);
    expect(parseDismissed('{"msg-1":true}')).toEqual([]);
    expect(parseDismissed('["msg-1", 7, null]')).toEqual(["msg-1"]);
  });
});

/** The notice's two decisions about a turn's writes, out where they can be tested — the
 *  same reason the dismissal store is out here. Both were inside the component, and one of
 *  them was WRONG in a way no test in this repo could see: undoing an item the turn had only
 *  edited deleted the whole file. */
describe("what the memory notice says and what its Undo does", () => {
  const write = (over: Partial<TurnWrite> = {}): TurnWrite => ({
    id: "n1",
    kind: "note",
    text: "Acme payment terms",
    sensitive: false,
    scope: "user",
    revision: 1,
    ...over,
  });

  it("undoes a fact, and a file the turn CREATED, by deleting it", () => {
    expect(undoRequest(write({ id: "c1", kind: "fact", revision: 1 }))).toEqual({
      path: "/api/memory/claims/c1",
      method: "DELETE",
      body: null,
    });
    expect(undoRequest(write({ revision: 1 }))).toEqual({
      path: "/api/memory/notes/n1",
      method: "DELETE",
      body: null,
    });
    // A fact's revision says nothing about its undo: a fact has no earlier version to go
    // back to, and a supersede is not something the notice offers.
    expect(undoRequest(write({ id: "c1", kind: "fact", revision: 4 }))).toMatchObject({ method: "DELETE" });
  });

  it("undoes a file the turn only EDITED by reverting it, never by deleting it", () => {
    // THE DEFECT THIS EXISTS FOR. The notice said "saved 1 thing" and its Undo removed a
    // file the turn had merely rewritten — with every revision of it, off every list, for a
    // person who asked only to leave the file as it was.
    expect(undoRequest(write({ revision: 2 }))).toEqual({
      path: "/api/memory/notes/n1",
      method: "PATCH",
      body: { revertTo: 1 },
    });
    // The target is the revision BEFORE the one the turn wrote, whatever that number is.
    expect(undoRequest(write({ revision: 7 }))).toMatchObject({ body: { revertTo: 6 } });
  });

  it("addresses the row by an encoded id, never by raw interpolation", () => {
    expect(undoRequest(write({ id: "a/b?c" }))).toMatchObject({ path: "/api/memory/notes/a%2Fb%3Fc" });
  });

  it("counts what was saved apart from what was updated", () => {
    // Two counts rather than one sentence over the total: a turn that rewrote an existing
    // file saved nothing, and "saved 1 thing" is the promise that made the wrong undo read
    // as the right one.
    expect(noticeCounts([write({ revision: 1 }), write({ id: "n2", revision: 3 }), write({ id: "c1", kind: "fact" })]))
      .toEqual({ saved: 2, updated: 1 });
    expect(noticeCounts([])).toEqual({ saved: 0, updated: 0 });
  });
});
