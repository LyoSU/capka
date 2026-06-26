import { describe, it, expect } from "vitest";
import { classifyLLMError, isTransientError } from "../friendly";

/**
 * Real reseller/gateway error strings seen in production beta logs. Non-technical
 * users wire up grey free gateways whose failures used to fall through to the
 * bland "unknown" message. They should classify into a meaningful category so
 * the user gets calm, actionable wording (and the owner/admin sees the raw "why"
 * in the detail). These are GENERAL patterns, not per-string hardcoding.
 *
 * Category choice also drives retry behaviour: only `rate_limited`/`network` are
 * treated as transient (the runner re-streams). A weekly quota or a check-in gate
 * is NOT transient — retrying wastes attempts — so it maps to `out_of_credits`.
 */
describe("classifyLLMError — reseller/gateway patterns", () => {
  it("treats an unsupported request format as a model-availability problem", () => {
    expect(classifyLLMError("Model qwen3-max is not supported for format oa-compat").category).toBe("model_unavailable");
  });

  it("treats a deprecated model as a model-availability problem", () => {
    expect(
      classifyLLMError("Error from provider: This model has been deprecated. It is recommended to migrate to xiaomi/mimo-v2.5").category,
    ).toBe("model_unavailable");
  });

  it("treats a weekly usage limit as an exhausted key (not a transient retry)", () => {
    expect(classifyLLMError("Weekly usage limit reached. Resets in 3 days.").category).toBe("out_of_credits");
    expect(isTransientError("Weekly usage limit reached. Resets in 3 days.")).toBe(false);
  });

  it("treats a daily check-in gate as an exhausted key, not retryable", () => {
    const raw = "daily discord check-in required; run /checkin in the server to unlock your key for today";
    expect(classifyLLMError(raw).category).toBe("out_of_credits");
    expect(isTransientError(raw)).toBe(false);
  });

  it("treats a saturated upstream group as rate limiting (genuinely transient)", () => {
    expect(classifyLLMError("Current group upstream load is saturated, please try again later").category).toBe("rate_limited");
    expect(isTransientError("Current group upstream load is saturated, please try again later")).toBe(true);
  });

  it("still surfaces the raw provider text as the admin/owner detail", () => {
    const raw = "Weekly usage limit reached. Resets in 3 days.";
    expect(classifyLLMError(raw).adminDetail).toContain("Weekly usage limit");
  });
});
