import { describe, it, expect } from "vitest";
import { resumeStep } from "../setup-steps";

describe("resumeStep — where the first-run wizard resumes", () => {
  it("starts at account creation when there is no session", () => {
    expect(resumeStep({ hasSession: false, hasProviderConfig: false })).toBe("account");
    // A stray provider row without a session is still pre-account.
    expect(resumeStep({ hasSession: false, hasProviderConfig: true })).toBe("account");
  });

  it("resumes at the provider step once the account exists but no provider is saved", () => {
    // This is the dead-end the change fixes: a refresh after sign-up must NOT
    // bounce back to account creation (which would fail as a duplicate).
    expect(resumeStep({ hasSession: true, hasProviderConfig: false })).toBe("provider");
  });

  it("resumes at the telegram step once a provider is configured", () => {
    expect(resumeStep({ hasSession: true, hasProviderConfig: true })).toBe("telegram");
  });
});
