import { describe, it, expect, vi } from "vitest";
import { log } from "./log.js";

describe("log", () => {
  it("emits one JSON line with event + fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("session.create", { sessionId: "s1", handle: "c1" });
    const line = JSON.parse(spy.mock.calls.at(-1)[0]);
    expect(line.event).toBe("session.create");
    expect(line.sessionId).toBe("s1");
    expect(line.handle).toBe("c1");
    expect(line.level).toBe("info");
    expect(typeof line.ts).toBe("string");
    spy.mockRestore();
  });
});
