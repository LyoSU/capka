import { describe, it, expect } from "vitest";
import { upgradePlugin } from "../install";

describe("upgradePlugin consent guard", () => {
  it("rejects an upgrade with no reviewed commit SHA (fail-closed, before any DB access)", async () => {
    // The guard runs first, so a blind 'pull latest' can never move the pin.
    await expect(upgradePlugin("any-install", "")).rejects.toThrow(/reviewed commit SHA/);
  });
});
