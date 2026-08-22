import { describe, it, expect } from "vitest";
import {
  buildRecoveryNote,
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
    // model must not re-run these.
    expect(note).toMatch(/ALREADY RAN/);
    expect(note).toMatch(/Do NOT repeat/);
  });

  it("clamps one call's arguments instead of replaying its payload", () => {
    // The note prevents repeated work; it is not a channel for carrying the work
    // forward, and a full row per entry is how this note would grow into the
    // overflow it exists to recover from.
    const fat: TurnEffect = { name: "wp_upload_image", input: { blob: "x".repeat(5000) } };
    const note = buildRecoveryNote([fat])!;
    expect(note).toContain("…");
    expect(note.length).toBeLessThan(EFFECT_ARG_CHARS + 600);
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
    expect(note).toMatch(/errored/);
    expect(note).toMatch(/verify/);
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
