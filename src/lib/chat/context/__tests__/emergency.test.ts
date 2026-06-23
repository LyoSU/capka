import { describe, it, expect } from "vitest";
import { trimToRecent, type ContextRow } from "@/lib/chat/context/build";

const row = (id: string, role: string): ContextRow => ({
  id, role, content: id, metadata: null, createdAt: null, platform: "web",
});

describe("trimToRecent", () => {
  it("keeps only the most recent messages and starts on a user turn", () => {
    const rows = [row("u1", "user"), row("a1", "assistant"), row("u2", "user"), row("a2", "assistant"), row("u3", "user"), row("a3", "assistant")];
    // last 3 = [a2, u3, a3]; leading assistant dropped → [u3, a3]
    const out = trimToRecent(rows, 3);
    expect(out.map((r) => r.id)).toEqual(["u3", "a3"]);
  });

  it("returns everything when there are fewer messages than the limit", () => {
    const rows = [row("u1", "user"), row("a1", "assistant")];
    expect(trimToRecent(rows, 10)).toBe(rows);
  });
});
