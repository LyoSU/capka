import { describe, it, expect } from "vitest";
import { buildCompactionMessages, COMPACTION_INSTRUCTION } from "@/lib/chat/context/compactor";
import type { ModelMessage } from "ai";

describe("buildCompactionMessages", () => {
  const system: ModelMessage[] = [{ role: "system", content: "persona" }];
  const history: ModelMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ];

  it("appends the compaction instruction as the final user turn, keeping the prefix intact", () => {
    const out = buildCompactionMessages(system, history);

    // Cache-friendly: the existing system + history prefix is preserved byte-for-byte
    // and in order, so the hot prompt-cache prefix from the just-finished turn hits.
    expect(out.slice(0, -1)).toEqual([...system, ...history]);

    // The instruction rides as the LAST message, as a user turn.
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe(COMPACTION_INSTRUCTION);
  });
});
