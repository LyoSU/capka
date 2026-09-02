import { describe, it, expect } from "vitest";
import { DISMISSED_MAX, nextDismissed, parseDismissed } from "../memory-notice";

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
