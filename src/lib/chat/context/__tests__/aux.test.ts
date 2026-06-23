import { describe, it, expect } from "vitest";
import { buildAuxRequest } from "@/lib/chat/context/aux";
import type { ModelMessage } from "ai";

describe("buildAuxRequest", () => {
  const system: ModelMessage[] = [{ role: "system", content: "persona" }];
  const history: ModelMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ];

  it("reuses the hot system+history prefix and appends the reply + instruction as the tail", () => {
    const out = buildAuxRequest(system, history, "the final answer", "Extract facts.");

    // Cache hit: the warmed prefix is preserved byte-for-byte, in order.
    expect(out.slice(0, system.length + history.length)).toEqual([...system, ...history]);

    // The just-produced assistant reply, then the instruction as the final user turn.
    expect(out[out.length - 2]).toEqual({ role: "assistant", content: "the final answer" });
    expect(out[out.length - 1]).toEqual({ role: "user", content: "Extract facts." });
  });

  it("omits the assistant turn when there is no reply text", () => {
    const out = buildAuxRequest(system, history, "", "Extract facts.");
    expect(out).toHaveLength(system.length + history.length + 1);
    expect(out[out.length - 1]).toEqual({ role: "user", content: "Extract facts." });
  });
});
