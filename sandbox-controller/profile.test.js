import { describe, it, expect } from "vitest";
import { resolveRuntimeProfile } from "./profile.js";

describe("resolveRuntimeProfile", () => {
  it("defaults to runc + the dev profile (gVisor is opt-in, boots anywhere)", () => {
    expect(resolveRuntimeProfile({})).toEqual({ runtime: "runc", profile: "dev" });
    expect(resolveRuntimeProfile()).toEqual({ runtime: "runc", profile: "dev" });
  });

  it("opting into runsc derives the secure profile", () => {
    expect(resolveRuntimeProfile({ runtime: "runsc" })).toEqual({ runtime: "runsc", profile: "secure" });
  });

  it("an explicit profile overrides the derived one", () => {
    expect(resolveRuntimeProfile({ runtime: "runsc", profile: "dev" })).toEqual({ runtime: "runsc", profile: "dev" });
  });
});
