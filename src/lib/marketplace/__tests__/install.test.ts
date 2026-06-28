import { describe, it, expect } from "vitest";
import { upgradePlugin } from "../install";

const SHA = "a".repeat(40);

describe("upgradePlugin consent guard", () => {
  it("rejects an upgrade with no reviewed commit SHA (fail-closed, before any DB access)", async () => {
    // The guard runs first, so a blind 'pull latest' can never move the pin.
    await expect(upgradePlugin("any-install", "")).rejects.toThrow(/reviewed commit SHA/);
  });

  it("rejects a branch/HEAD ref as toSha (would re-dereference to live upstream HEAD)", async () => {
    // C3/L4: only a full 40-hex SHA is a real pin; anything else is rejected
    // before any DB or network access, so a branch tip can't be applied.
    await expect(upgradePlugin("any-install", "main")).rejects.toThrow(/40-character hex commit SHA/);
    await expect(upgradePlugin("any-install", "HEAD")).rejects.toThrow(/40-character hex commit SHA/);
    await expect(upgradePlugin("any-install", SHA.slice(0, 39))).rejects.toThrow(/40-character hex commit SHA/); // too short
    await expect(upgradePlugin("any-install", SHA.toUpperCase())).rejects.toThrow(/40-character hex commit SHA/); // uppercase isn't git's canonical form
    await expect(upgradePlugin("any-install", `${SHA}g`)).rejects.toThrow(/40-character hex commit SHA/); // non-hex
  });

  it("accepts a valid 40-hex SHA past the format guard (proceeds to the install lookup)", async () => {
    // A well-formed pin clears the synchronous SHA check and reaches the DB lookup,
    // so whatever it rejects with, it is NOT the 40-hex format error.
    await expect(upgradePlugin("no-such-install", SHA)).rejects.not.toThrow(/40-character hex commit SHA/);
  });
});
