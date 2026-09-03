import { describe, it, expect } from "vitest";
import type { TurnWrite } from "@/lib/vault/turn-writes";
import { edited, undoRequest } from "../memory-notice";

/** The memory row's two decisions about a turn's writes, out where they can be tested: this
 *  suite runs with `environment: "node"` and has no React renderer. Both were once inside the
 *  component, and one of them was WRONG in a way no test in this repo could see: undoing an
 *  item the turn had only edited deleted the whole file. */
describe("what the memory row says and what its Undo does", () => {
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
    // back to, and a supersede is not something the row offers.
    expect(undoRequest(write({ id: "c1", kind: "fact", revision: 4 }))).toMatchObject({ method: "DELETE" });
  });

  it("undoes a file the turn only EDITED by reverting it, never by deleting it", () => {
    // THE DEFECT THIS EXISTS FOR. The notice said "saved 1 thing" and its Undo removed a
    // file the turn had merely rewritten — with every revision of it, off every list, for a
    // person who asked only to leave the file as it was.
    expect(undoRequest(write({ revision: 2 }))).toEqual({
      path: "/api/memory/notes/n1",
      method: "PATCH",
      body: { revertTo: 1, expectedRevision: 2 },
    });
    // The target is the revision BEFORE the one the turn wrote, whatever that number is.
    expect(undoRequest(write({ revision: 7 }))).toMatchObject({ body: { revertTo: 6 } });
  });

  it("sends the revision it DISPLAYED, so a file edited since is refused rather than rolled back", () => {
    // `revertTo` is computed from client state. If a later turn edited the same file
    // between the render and the click, the target is still strictly below the new head, so
    // an unguarded revert succeeds and drops that later edit out of the head — for a person
    // who never saw it and has no version history to find it in. The head the row was
    // looking at travels with the request and the server compares it.
    expect(undoRequest(write({ revision: 7 }))).toMatchObject({ body: { expectedRevision: 7 } });
    // Never on a delete: there is nothing to be stale about — the wish is that the row not
    // be there, and a row somebody else already removed satisfies it.
    expect(undoRequest(write({ revision: 1 })).body).toBeNull();
  });

  it("addresses the row by an encoded id, never by raw interpolation", () => {
    expect(undoRequest(write({ id: "a/b?c" }))).toMatchObject({ path: "/api/memory/notes/a%2Fb%3Fc" });
  });

  it("tells a file the turn only edited apart from one it created, at the predicate the button uses", () => {
    // The row's verb ("saved" / "updated") and its Undo (delete / revert) are decided by the
    // same function, so they cannot disagree: "saved" over a control that reverts was the
    // shape that made the wrong undo look right.
    expect(edited(write({ revision: 1 }))).toBe(false);
    expect(edited(write({ revision: 3 }))).toBe(true);
    expect(edited(write({ kind: "fact", revision: 3 }))).toBe(false);
  });
});
