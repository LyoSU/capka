import { describe, it, expect } from "vitest";
import {
  buildRecoveryNote,
  clampEffectInput,
  effectsFromParts,
  mergeEffects,
  EFFECT_ARG_CHARS,
  RECOVERY_NOTE_BUDGET,
  type TurnEffect,
} from "@/lib/tasks/effect-ledger";
import type { StoredPart } from "@/lib/chat/contracts";

const upsert = (sku: string): TurnEffect => ({ name: "zak_upsert_product", input: { sku, price: 199 } });

describe("buildRecoveryNote", () => {
  it("says nothing when the turn had done nothing", () => {
    // A turn that overflowed before executing anything has no side effects to
    // warn about, and a note there would only spend prompt on noise.
    expect(buildRecoveryNote([])).toBeNull();
  });

  it("itemizes the calls so the model can see which rows are done", () => {
    const note = buildRecoveryNote([upsert("CLR-001"), upsert("CLR-002")])!;
    expect(note).toContain("CLR-001");
    expect(note).toContain("CLR-002");
    expect(note).toContain("zak_upsert_product");
    // It has to read as state, not as a request — the whole point is that the
    // model must not re-run these. Was pinned on the phrase "ALREADY RAN"; the
    // header no longer makes that claim about the whole list, because a list can
    // contain a call that ran and THREW, whose effects are not known to be live.
    // The prohibition is what the test was ever about, so that is what it pins.
    expect(note).toMatch(/effects are live/);
    expect(note).toMatch(/do NOT repeat/);
    // …and it must not narrate the machinery to the user, same rule as resume.ts.
    expect(note).toMatch(/do not mention this note or the restart/);
  });

  // A write-ahead row is a WEAKER claim than the rest of the list: the call was
  // entered and no outcome ever came back. Telling the model it "ALREADY RAN" is the
  // one error worse than a repeat — it teaches the model to skip work that may never
  // have happened, and an omission leaves no trace to notice.
  it("does not tell the model a call already ran when no outcome ever arrived", () => {
    const note = buildRecoveryNote([{ name: "send_invoice", input: { id: 7 }, unsettled: true }])!;
    expect(note).not.toMatch(/ALREADY RAN/);
  });

  it("marks an unsettled call apart from one that completed", () => {
    const note = buildRecoveryNote([
      { name: "create_row", input: { i: 1 } },
      { name: "send_invoice", input: { id: 7 }, unsettled: true },
    ])!;
    const [ran, maybe] = note.split("\n").filter((l) => l.startsWith("- "));
    // The invariant is the DISTINCTION, not a chosen word or a position: the uncertain
    // entry carries a bracketed state and the completed one carries none. Pinning the
    // verb, or the marker's place on the line, pins the vocabulary rather than the
    // behaviour — and both have already moved once.
    expect(maybe).toMatch(/\[[^\]]+\]/);
    expect(ran).not.toMatch(/\[[^\]]+\]/);
  });

  it("clamps one call's arguments instead of replaying its payload", () => {
    // The note prevents repeated work; it is not a channel for carrying the work
    // forward, and a full row per entry is how this note would grow into the
    // overflow it exists to recover from.
    const fat: TurnEffect = { name: "wp_upload_image", input: { blob: "x".repeat(5000) } };
    const note = buildRecoveryNote([fat])!;
    expect(note).toContain("…");
    // The invariant is that the PAYLOAD is not replayed; the bound was `EFFECT_ARG_CHARS
    // + 600`, where 600 was slack for a header that has since grown to enumerate three
    // states and carry the no-narration rule. Asserting the payload's absence directly
    // says what the test is for, and the length bound is left generous enough that it
    // only catches unbounded growth rather than any rewording.
    expect(note).not.toContain("x".repeat(EFFECT_ARG_CHARS + 1));
    expect(note.length).toBeLessThan(EFFECT_ARG_CHARS + 1200);
  });

  it("stays inside its budget on a 193-call turn, and still names every tool", () => {
    // This is the shape that caused the bug: ~200 executed calls. The note rides
    // in the prompt of a retry that just died of an oversized prompt, so an
    // unbounded list would re-create that failure.
    const effects: TurnEffect[] = [
      ...Array.from({ length: 98 }, (_, i) => upsert(`CLR-${i}`)),
      ...Array.from({ length: 30 }, () => ({ name: "wp_upload_image", input: { file: "photo.jpg" } })),
      ...Array.from({ length: 14 }, () => ({ name: "wp_publish_product", input: { id: 7 } })),
    ];

    const note = buildRecoveryNote(effects)!;

    expect(note.length).toBeLessThanOrEqual(RECOVERY_NOTE_BUDGET + 200);
    // Degraded to counts, but nothing is silently dropped — an omitted tool is
    // exactly the one that gets run twice.
    expect(note).toContain("zak_upsert_product ×98");
    expect(note).toContain("wp_upload_image ×30");
    expect(note).toContain("wp_publish_product ×14");
  });

  it("flags a call that errored as needing verification, not as clean", () => {
    // "Did it land?" is the question the ledger exists to answer, and a tool that
    // writes and then throws is the one case where it genuinely cannot — so it must
    // say so rather than stay silent.
    const note = buildRecoveryNote([{ name: "wp_upload_image", input: { file: "a.jpg" }, failed: true }])!;
    expect(note).toMatch(/\[errored\] wp_upload_image/);
    // Was pinned on the word "verify", which also reads as "re-read this note". The
    // instruction now names the CLASS of action instead, which is what biases the
    // model toward a non-mutating call it can actually pick.
    expect(note).toMatch(/read, list or query/);
  });

  // Found by reading the RENDERED note rather than the code. The header instructed
  // the model to "inspect the target its arguments identify" directly above a lead
  // announcing that "the individual arguments are not available" — one state, two
  // statements, disagreeing. The collapsed form has its own instruction (guard each
  // write as you make it), so the per-item one must not also be standing there.
  it("does not tell the model to use arguments the collapsed form has dropped", () => {
    const note = buildRecoveryNote(Array.from({ length: 400 }, (_, i) => upsert(`CLR-${i}`)))!;
    expect(note).toContain("counts only");
    expect(note).not.toMatch(/arguments identify/);
  });

  it("carries the errored count through the collapsed form too", () => {
    // Big enough that the itemized form no longer fits — the collapsed form must
    // not lose the one distinction that matters most.
    const effects: TurnEffect[] = [
      ...Array.from({ length: 400 }, (_, i) => upsert(`CLR-${i}`)),
      ...Array.from({ length: 8 }, () => ({ name: "wp_upload_image", input: { file: "x.jpg" }, failed: true })),
    ];
    const note = buildRecoveryNote(effects)!;
    expect(note).toContain("counts only");
    expect(note).toContain("wp_upload_image ×8");
    expect(note).toMatch(/8 errored/);
  });

  it("bounds the collapsed form itself, not just the switch into it", () => {
    // The budget used to gate only the DECISION to collapse; the result was one line
    // per distinct tool name, unbounded. A deployment with a few busy MCP connectors
    // puts hundreds of names in reach, and this note rides in the prompt of a retry
    // that just died of an oversized one.
    const effects: TurnEffect[] = Array.from({ length: 400 }, (_, i) => ({
      name: `mcp_connector_${i}_do_a_thing_with_a_long_name`,
      input: { sku: `S-${i}` },
    }));
    const note = buildRecoveryNote(effects)!;
    expect(note.length).toBeLessThanOrEqual(RECOVERY_NOTE_BUDGET);
    // Collapsed, but the tail is accounted for rather than dropped — an invisible
    // tool is the one that gets run twice.
    expect(note).toMatch(/and \d+ more tools, \d+ calls/);
  });

  it("says nothing rather than \"null\" for a call with no arguments", () => {
    // The table stores SQL NULL for a no-argument call, so loadEffects hands back
    // `null` where `parts` would hand back `undefined`. `JSON.stringify(null)` is the
    // string "null", which put a line reading `- wp_publish_product null` into a
    // prompt that had just died of its own size.
    const note = buildRecoveryNote([{ name: "wp_publish_product", input: null }])!;
    expect(note).toContain("- wp_publish_product");
    expect(note).not.toContain("null");
  });

  it("keeps a call whose arguments cannot be serialized", () => {
    // The call ran. Losing the entry because its input has a cycle would trade a
    // missing argument for a repeated write.
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    const note = buildRecoveryNote([{ name: "wp_create_variable_product", input: cyclic }])!;
    expect(note).toContain("wp_create_variable_product");
  });
});

describe("effectsFromParts", () => {
  // The persisted shape: what a reply row's metadata.parts actually holds. A
  // continuation is a SECOND task writing the SAME row, so this — not process
  // memory — is where the first half's executed calls live.
  const call = (id: string, name: string, input: unknown): StoredPart => ({ type: "tool-call", id, name, input });
  const result = (id: string, name: string): StoredPart => ({ type: "tool-result", id, name, output: { ok: true } });
  const failed = (id: string, name: string): StoredPart => ({ type: "tool-error", id, name, error: "boom" });
  const rejected = (id: string, name: string): StoredPart => ({ type: "tool-error", id, name, error: "bad args", invalid: true });

  it("rebuilds executed calls from a row, pairing arguments to their evidence", () => {
    const effects = effectsFromParts([
      { type: "text", text: "adding them now" },
      call("1", "zak_upsert_product", { sku: "CLR-001" }),
      result("1", "zak_upsert_product"),
      call("2", "wp_upload_image", { file: "a.jpg" }),
      failed("2", "wp_upload_image"),
    ]);

    // The id rides along so this source can be merged with the durable ledger
    // without one call being counted from both.
    expect(effects).toEqual([
      { id: "1", name: "zak_upsert_product", input: { sku: "CLR-001" } },
      { id: "2", name: "wp_upload_image", input: { file: "a.jpg" }, failed: true },
    ]);
  });

  it("does not report a call the SDK rejected before running as done", () => {
    // `invalid` means the SDK synthesized this error itself for a call it refused to
    // run, so it is not evidence anything happened. This path is what a CONTINUATION
    // reads, and the table has no row for such a call — so mergeEffects would keep a
    // parts-only entry and the restarted half would be told "already ran, do not
    // repeat" about work that never ran. That omission leaves the row unwritten,
    // which is worse than the duplication this module prevents.
    expect(
      effectsFromParts([call("1", "zak_upsert_product", { sku: "CLR-001" }), rejected("1", "zak_upsert_product")]),
    ).toEqual([]);
  });

  it("still reports a call that ran and then threw", () => {
    // The neighbouring case, so the guard above can't widen into it: a tool that
    // writes and then fails HAS written, and that is the entry the note most needs.
    const effects = effectsFromParts([call("1", "wp_upload_image", { file: "a.jpg" }), failed("1", "wp_upload_image")]);
    expect(effects).toEqual([{ id: "1", name: "wp_upload_image", input: { file: "a.jpg" }, failed: true }]);
  });

  it("does not report a call that never ran as done", () => {
    // A tool-call with no result is either still in flight or was suspended for
    // approval and never executed. Reporting it would tell the model not to do
    // something it has not done — and the row would silently go unwritten.
    expect(effectsFromParts([call("1", "zak_upsert_product", { sku: "CLR-001" })])).toEqual([]);
  });

  it("survives a result whose call is missing from the row", () => {
    // Orphans exist in the wild (a sealed dangling call from an interrupted turn).
    // The evidence that it ran is the result, so the entry has to stand without its
    // arguments rather than be dropped.
    const effects = effectsFromParts([result("9", "wp_publish_product")]);
    expect(effects).toEqual([{ id: "9", name: "wp_publish_product", input: undefined }]);
  });

  it("feeds straight into the note the restarted turn reads", () => {
    const note = buildRecoveryNote(
      effectsFromParts([call("1", "zak_upsert_product", { sku: "CLR-777" }), result("1", "zak_upsert_product")]),
    )!;
    expect(note).toContain("CLR-777");
  });
});

describe("mergeEffects", () => {
  // During a rolling upgrade one message can hold effects in BOTH places: the half
  // that ran before the table existed is only in `parts`, the half after it only in
  // the ledger. Choosing one source drops the other, and a dropped effect is
  // precisely the one that gets done twice.
  it("keeps an effect that exists only in the rebuilt parts", () => {
    const ledger = [{ id: "c2", name: "second", input: 2 }];
    const fromParts = [{ id: "c1", name: "first", input: 1 }];

    expect(mergeEffects(ledger, fromParts).map((e) => e.id)).toEqual(["c1", "c2"]);
  });

  // The ledger is the stronger record: `parts` cannot say whether a call errored
  // once and then succeeded, and it is what an emergency trim erases.
  it("lets the ledger win when both sources describe the same call", () => {
    const ledger = [{ id: "c1", name: "upsert_row", input: { sku: "A" }, failed: true }];
    const fromParts = [{ id: "c1", name: "upsert_row", input: { sku: "A" } }];

    expect(mergeEffects(ledger, fromParts)).toEqual(ledger);
  });
});

/**
 * What the row keeps. The column is jsonb and took whatever the model emitted, which
 * on a bulk write is the payload itself — stored twice per call now that dispatch is
 * recorded before the outcome, kept for the life of the chat, and read back by exactly
 * one consumer that clamps it to a hundred characters.
 */
describe("clampEffectInput", () => {
  it("leaves an ordinary call's arguments exactly as they were", () => {
    // The common case must be untouched, not merely equivalent: a clamp that rewrote
    // every row would change what every recovery note says to buy nothing, since the
    // rows that matter for size are a small minority.
    const input = { sku: "CLR-001", price: 199, tags: ["silver", "new"] };
    expect(clampEffectInput(input)).toBe(input);
  });

  it("keeps the field that identifies the target and drops the one that replays it", () => {
    // The shape this exists for, with `path` deliberately AFTER the body. Clamping the
    // serialization by prefix — which is what the renderer does and what a naive
    // storage bound would do — keeps two kilobytes of `content` and loses `path`
    // entirely, so the note names a write it cannot identify.
    const clamped = clampEffectInput({ content: "x".repeat(400_000), path: "/srv/report.csv" }) as Record<string, unknown>;

    expect(clamped.path).toBe("/srv/report.csv");
    expect(String(clamped.content)).toContain("KB");
    expect(JSON.stringify(clamped).length).toBeLessThan(400);
  });

  it("makes the note able to name the file, which is the whole point", () => {
    // Asserted through the note rather than on the clamped object, because the object
    // is not what anything reads. Before the bound this line was 100 characters of `x`.
    const note = buildRecoveryNote([
      { name: "write_file", input: clampEffectInput({ content: "x".repeat(400_000), path: "/srv/report.csv" }) },
    ]);
    expect(note).toContain("/srv/report.csv");
    expect(note).not.toContain("x".repeat(EFFECT_ARG_CHARS));
  });

  it("says how much it dropped instead of eliding in silence", () => {
    // An argument that simply vanishes reads as an argument the call never had, and the
    // model cannot then tell a truncation from a default. Both non-scalar shapes carry
    // a count as well as a size, for the same reason the degraded note does.
    const clamped = clampEffectInput({
      rows: Array.from({ length: 900 }, (_, i) => ({ sku: `S-${i}`, body: "y".repeat(200) })),
      target: { host: "a".repeat(3000), token: "b".repeat(3000) },
      label: "nightly",
    }) as Record<string, unknown>;

    expect(clamped.label).toBe("nightly");
    expect(String(clamped.rows)).toContain("900 items");
    expect(String(clamped.target)).toContain("2 fields");
  });

  it("bounds the field count too, not only each field's size", () => {
    // Thirty-two short fields are small; ten thousand are not, and the per-field clamp
    // does nothing about them. A remainder line rather than a silent cut — the same
    // rule the degraded note follows.
    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, "v".repeat(40)]));
    const clamped = clampEffectInput(wide) as Record<string, unknown>;

    expect(Object.keys(clamped).length).toBeLessThan(40);
    expect(String(clamped["…"])).toContain("more fields");
  });

  it("names the target even for a row written before the bound existed", () => {
    // The clamp only shapes NEW rows. Every row already in the table holds the full
    // payload, and those are exactly the rows a restart is most likely to read — so the
    // renderer has to survive an unclamped input on its own, without the storage half
    // helping. No clampEffectInput here on purpose.
    const note = buildRecoveryNote([
      { name: "write_file", input: { content: "x".repeat(400_000), path: "/srv/report.csv" } },
    ]);
    expect(note).toContain("/srv/report.csv");
    expect(note).not.toContain("x".repeat(EFFECT_ARG_CHARS));
  });

  it("falls back to a prefix when even one field outgrows the whole budget", () => {
    // Nothing survives the cheapest-first pass, and `{…+1}` would say strictly less
    // than a clamped prefix of the one field there is.
    const note = buildRecoveryNote([{ name: "run", input: { script: "s".repeat(5_000) } }]);
    expect(note).toContain("…");
    expect(note!.length).toBeLessThan(EFFECT_ARG_CHARS + 1200);
  });

  it("clamps a bare oversized value that is not an object at all", () => {
    // A tool whose entire input is one long string. Nothing to keep a field of, so the
    // prefix is all there is — but it still has to be bounded and still has to say so.
    const clamped = String(clampEffectInput("z".repeat(50_000)));
    expect(clamped.length).toBeLessThan(EFFECT_ARG_CHARS + 40);
    expect(clamped).toContain("KB");
  });
});
