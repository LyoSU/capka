import { describe, it, expect } from "vitest";
import { assertRuntimeAvailable } from "./runtime-check.js";

const dockerWith = (runtimes) => ({ info: async () => ({ Runtimes: runtimes }) });

describe("assertRuntimeAvailable", () => {
  it("passes when runsc is registered", async () => {
    await expect(
      assertRuntimeAvailable(dockerWith({ runc: {}, runsc: {} }), { profile: "secure", runtime: "runsc" }),
    ).resolves.toBeUndefined();
  });
  it("throws (fail-closed) when runsc missing in secure profile", async () => {
    await expect(
      assertRuntimeAvailable(dockerWith({ runc: {} }), { profile: "secure", runtime: "runsc" }),
    ).rejects.toThrow(/runsc/);
  });
  it("allows runc in dev profile", async () => {
    await expect(
      assertRuntimeAvailable(dockerWith({ runc: {} }), { profile: "dev", runtime: "runc" }),
    ).resolves.toBeUndefined();
  });
  it("throws (fail-closed) when secure profile is paired with runc", async () => {
    await expect(
      assertRuntimeAvailable(dockerWith({ runc: {}, runsc: {} }), { profile: "secure", runtime: "runc" }),
    ).rejects.toThrow(/secure profile requires the gVisor runtime/);
  });
});
