import { describe, it, expect } from "vitest";
import { classify, ownerAuthored, migrationInferred, horizonFor, QUOTE_MIN_CHARS, HORIZON_DAYS } from "../grounding";

const ctx = (over: Partial<Parameters<typeof classify>[1]> = {}) => ({
  statement: "Acme invoices are paid monthly",
  userTurnText: "Acme invoices are paid monthly, please remember that",
  untrustedIngressSeen: false,
  ...over,
});

describe("classify — current_user_quote, the four clauses", () => {
  it("grants user_direct when all four clauses hold", () => {
    const v = classify({ kind: "current_user_quote", quote: "Acme invoices are paid monthly" }, ctx());
    expect(v).toEqual({ sourceClass: "user_direct", downgraded: false, failedClause: null });
  });

  it("clause 1 — a quote that is not verbatim in the turn degrades, it does not refuse", () => {
    const v = classify({ kind: "current_user_quote", quote: "Acme invoices are paid weekly" }, ctx());
    expect(v.sourceClass).toBe("agent_inferred");
    expect(v.downgraded).toBe(true);
    expect(v.failedClause).toBe(1);
  });

  it("clause 2 — an occurrence INSIDE a quoted span does not count as the user's words", () => {
    // The whole statement sits inside guillemets: a marked paste of someone else's text.
    const v = classify(
      { kind: "current_user_quote", quote: "Acme invoices are paid monthly" },
      ctx({ userTurnText: "the vendor PDF says «Acme invoices are paid monthly» — check it" }),
    );
    expect(v.sourceClass).toBe("agent_inferred");
    expect(v.failedClause).toBe(2);
  });

  it("clause 3 — a quote under the floor cannot carry the class", () => {
    const v = classify({ kind: "current_user_quote", quote: "Acme" }, ctx());
    expect("Acme".length).toBeLessThan(QUOTE_MIN_CHARS);
    expect(v.failedClause).toBe(3);
  });

  it("clause 4 — locating the quote is NOT locating the claim (N1)", () => {
    // The quote is genuinely the user's, at length, outside any quoted span. The
    // STATEMENT is unrelated to it. Round 1 minted `manifest` here.
    const v = classify(
      { kind: "current_user_quote", quote: "please check this for me" },
      ctx({ statement: "The director of Acme is Olena", userTurnText: "please check this for me when you can" }),
    );
    expect(v.sourceClass).toBe("agent_inferred");
    expect(v.failedClause).toBe(4);
  });

  it("is NOT capped by taint — a person who uploads a file still typed their own address", () => {
    const v = classify(
      { kind: "current_user_quote", quote: "Acme invoices are paid monthly" },
      ctx({ untrustedIngressSeen: true }),
    );
    expect(v.sourceClass).toBe("user_direct");
  });

  it("degrades to untrusted_derived, not agent_inferred, when the turn is tainted", () => {
    const v = classify({ kind: "current_user_quote", quote: "nope" }, ctx({ untrustedIngressSeen: true }));
    expect(v.sourceClass).toBe("untrusted_derived");
    expect(v.downgraded).toBe(true);
  });
});

describe("classify — retrieved and agent_inference", () => {
  it("retrieved inherits the LEAST-trusted class among its handles", () => {
    expect(
      classify({ kind: "retrieved", classes: ["user_direct", "untrusted_derived"] }, ctx()).sourceClass,
    ).toBe("untrusted_derived");
    expect(classify({ kind: "retrieved", classes: ["owner_authored", "agent_inferred"] }, ctx()).sourceClass)
      .toBe("agent_inferred");
  });

  it("retrieved over an empty set throws rather than failing open (M8)", () => {
    expect(() => classify({ kind: "retrieved", classes: [] }, ctx())).toThrow(/non-empty/i);
  });

  it("agent_inference is agent_inferred, capped at untrusted_derived by taint", () => {
    expect(classify({ kind: "agent_inference" }, ctx()).sourceClass).toBe("agent_inferred");
    expect(classify({ kind: "agent_inference" }, ctx({ untrustedIngressSeen: true })).sourceClass)
      .toBe("untrusted_derived");
  });

  it("caps a retrieved write at agent_inferred even in a CLEAN turn", () => {
    // Review LOW-1, pinned rather than left to the reader: the top three entries of
    // WEAKEST_FIRST can never be an OUTPUT of this arm. Grounding a write on a
    // `manifest`-class row does not make the write `manifest` — the AGENT composed the
    // sentence, and `user_direct` is reserved for the statement-to-quote tie. Without
    // this case the floor cap reads as taint-only and somebody "fixes" it.
    expect(classify({ kind: "retrieved", classes: ["owner_authored"] }, ctx()).sourceClass)
      .toBe("agent_inferred");
    expect(classify({ kind: "retrieved", classes: ["legacy_confirmed", "user_direct"] }, ctx()).sourceClass)
      .toBe("agent_inferred");
  });

  it("never reports downgraded for the two arms that asked for nothing stronger", () => {
    expect(classify({ kind: "agent_inference" }, ctx()).downgraded).toBe(false);
    expect(classify({ kind: "retrieved", classes: ["agent_inferred"] }, ctx()).downgraded).toBe(false);
  });
});

describe("the human minters", () => {
  it("names the two acts a PERSON performs", () => {
    expect(ownerAuthored()).toBe("owner_authored");
    expect(migrationInferred()).toBe("agent_inferred");
  });
});

describe("horizonFor", () => {
  it("never expires what the person said, and gives everything else 90 days", () => {
    for (const c of ["user_direct", "owner_authored", "legacy_confirmed"] as const) {
      expect(horizonFor(c)).toBeNull();
    }
    for (const c of ["agent_inferred", "untrusted_derived"] as const) {
      const at = horizonFor(c)!;
      expect(Math.round((at.getTime() - Date.now()) / 86_400_000)).toBe(HORIZON_DAYS);
    }
  });
});
