import { describe, it, expect } from "vitest";
import { makeTurnTaint, foldAssembledRows, untrustedOutputOf } from "../turn-taint";

describe("TurnTaint", () => {
  it("is monotonic and writes exactly once", async () => {
    const writes: string[] = [];
    const t = makeTurnTaint({ messageId: "m1", seeded: false, write: async (id) => { writes.push(id); } });
    expect(t.seen()).toBe(false);
    await t.mark("tool_result");
    await t.mark("provider_tool");
    expect(t.seen()).toBe(true);
    expect(writes).toEqual(["m1"]);           // one statement per turn, not per step
  });

  it("a seeded half starts true and writes nothing — the row already says so", async () => {
    const writes: string[] = [];
    const t = makeTurnTaint({ messageId: "m1", seeded: true, write: async (id) => { writes.push(id); } });
    expect(t.seen()).toBe(true);
    await t.mark("tool_result");
    expect(writes).toEqual([]);
  });

  it("folds an ABSENT mark as clean, which is the round-5 deviation and not an oversight", () => {
    // Review MED-2. The earlier draft titled this "folds a row with NO mark as untrusted"
    // and then asserted only the `true`/`false` cases — so the title claimed a fail-closed
    // predicate the implementation would not have had, and no case could have caught it.
    //
    // The spec's round-5 amendment settles which way it goes and says what it costs:
    // `messages.untrusted_ingress` is `NOT NULL DEFAULT false`, which is what makes the
    // column implementable against existing history at all, so an unmarked row IS clean.
    // The fail-closed property therefore rests on the tool-registration default and the
    // six construction sites, NOT on this predicate — and §11.12's acceptance test is what
    // catches a seventh source added without a mark. This case exists to stop a future
    // reader from "restoring" a second belt that the column cannot carry.
    expect(foldAssembledRows([{ untrustedIngress: false }])).toBe(false);
    expect(foldAssembledRows([{ untrustedIngress: true }])).toBe(true);
    expect(foldAssembledRows([{ untrustedIngress: false }, { untrustedIngress: true }])).toBe(true);
    expect(foldAssembledRows([{}])).toBe(false);
    expect(foldAssembledRows([{ untrustedIngress: null }])).toBe(false);
    expect(foldAssembledRows([])).toBe(false);
  });
});

/**
 * The runner's tool-result site, reduced to the two things it composes: the REAL
 * `untrustedOutputOf` predicate and the REAL taint. The `case "tool-result":` switch
 * around it needs a model, a sandbox and a queue to reach, so what is replayed here is
 * the one line of it this task owns —
 *   `if (untrustedOutputOf(rawTools, event.toolName)) await taint.mark("tool_result")`
 * — imported rather than restated, so a change to the predicate reaches these cases.
 */
const runTurnWith = async (results: { name: string; untrustedOutput?: boolean }[]) => {
  const marks: string[] = [];
  const rawTools: Record<string, unknown> = {};
  for (const r of results) {
    // A tool that DECLARES the opt-out is in the registration; one that does not
    // declare it is either an ordinary undeclared local tool or — when absent from
    // `rawTools` entirely — provider-executed. Both must read untrusted.
    if (r.untrustedOutput !== undefined) rawTools[r.name] = { untrustedOutput: r.untrustedOutput };
    else if (r.name !== "provider_side") rawTools[r.name] = {};
  }
  const taint = makeTurnTaint({ messageId: "m1", seeded: false, write: async () => {} });
  for (const r of results) {
    if (untrustedOutputOf(rawTools, r.name)) {
      marks.push("tool_result");
      await taint.mark("tool_result");
    }
  }
  return { marks, taint };
};

describe("the tool-result mark is decided per result", () => {
  it("marks an untrusted tool result and NOT an opted-out local one, in the same turn", async () => {
    // Both in ONE turn, because the failure mode is "the second overrode the first" and a
    // per-turn boolean cannot show that from two separate turns. The opted-out tool runs
    // FIRST and must leave the row clean; the untrusted one runs second and must flip it.
    const { marks, taint } = await runTurnWith([
      { name: "capka_safe", untrustedOutput: false },
      { name: "capka_fetch" },                          // undeclared => untrusted
    ]);
    expect(marks).toEqual(["tool_result"]);             // exactly one, from the second tool
    expect(taint.seen()).toBe(true);
  });

  it("leaves the row clean for a turn of opted-out tools only", async () => {
    // The control. Without it the test above passes for an implementation that marks
    // unconditionally, which is precisely the bug this site exists to avoid.
    const { marks, taint } = await runTurnWith([{ name: "capka_safe", untrustedOutput: false }]);
    expect(marks).toEqual([]);
    expect(taint.seen()).toBe(false);
  });

  it("marks a tool the runner cannot find at all — a provider-executed one", async () => {
    // Absent from `rawTools` because it has no local `execute` and was never wrapped.
    // A provider-side fetch is not Capka-authored, so it cannot inherit the opt-out an
    // absent registration would otherwise read as "undeclared, therefore silent".
    const { marks } = await runTurnWith([{ name: "provider_side" }]);
    expect(marks).toEqual(["tool_result"]);
  });
});
