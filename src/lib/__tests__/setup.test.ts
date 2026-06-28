import { describe, it, expect } from "vitest";
import { resumeStep } from "../setup-steps";

describe("resumeStep — where the first-run wizard resumes", () => {
  it("starts at account creation when there is no session", () => {
    expect(resumeStep({ hasSession: false, adminClaimed: false })).toBe("account");
  });

  it("resumes at the provider step once admin is claimed", () => {
    // A refresh after the account+token step must NOT bounce back to account
    // creation (which would dead-end on a duplicate sign-up). The provider step
    // is also the final step — saving it completes setup.
    expect(resumeStep({ hasSession: true, adminClaimed: true })).toBe("provider");
  });

  it("stays on the account step while signed in but admin is not yet claimed", () => {
    // Signed up but the SETUP_TOKEN claim hasn't happened yet (e.g. a refresh
    // in between): resume on the account step so the operator can submit it,
    // rather than skipping ahead and failing to complete.
    expect(resumeStep({ hasSession: true, adminClaimed: false })).toBe("account");
  });
});
