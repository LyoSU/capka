import { describe, it, expect } from "vitest";
import { notReadyGuard } from "./readiness.js";

describe("notReadyGuard", () => {
  it("blocks non-health routes until ready", () => {
    expect(notReadyGuard({ ready: false, path: "/sessions" })).toEqual({ block: true, status: 503 });
  });
  it("always allows /health", () => {
    expect(notReadyGuard({ ready: false, path: "/health" })).toEqual({ block: false });
  });
  it("allows routes once ready", () => {
    expect(notReadyGuard({ ready: true, path: "/sessions" })).toEqual({ block: false });
  });
});
