import { describe, it, expect } from "vitest";
import { resumeStep } from "../setup-steps";

describe("resumeStep — where the first-run wizard resumes", () => {
  it("starts at account creation when there is no session", () => {
    expect(resumeStep({ hasSession: false })).toBe("account");
  });

  it("resumes at the provider step once the account exists", () => {
    // This is the dead-end the change guards against: a refresh after sign-up
    // must NOT bounce back to account creation (which would fail as a
    // duplicate). The provider step is also the final step — saving it
    // completes setup — so a signed-in admin always resumes here.
    expect(resumeStep({ hasSession: true })).toBe("provider");
  });
});
