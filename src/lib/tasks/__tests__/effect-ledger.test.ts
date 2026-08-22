import { describe, it, expect } from "vitest";
import {
  buildRecoveryNote,
  EFFECT_ARG_CHARS,
  RECOVERY_NOTE_BUDGET,
  type TurnEffect,
} from "@/lib/tasks/effect-ledger";

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

  it("keeps a call whose arguments cannot be serialized", () => {
    // The call ran. Losing the entry because its input has a cycle would trade a
    // missing argument for a repeated write.
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    const note = buildRecoveryNote([{ name: "wp_create_variable_product", input: cyclic }])!;
    expect(note).toContain("wp_create_variable_product");
  });
});
