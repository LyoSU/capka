import { describe, it, expect } from "vitest";

import { makeVaultBudget, VAULT_TURN_MAX_BYTES } from "../budget";

describe("vault turn budget", () => {
  it("passes results through until the ceiling, then says so and nothing else", () => {
    const b = makeVaultBudget(20);
    expect(b.emit("0123456789")).toBe("0123456789");
    expect(b.emit("0123456789")).toBe("0123456789");
    expect(b.emit("x")).toMatch(/reached their budget/);
  });

  it("stays exhausted - a smaller later call does not slip through", () => {
    const b = makeVaultBudget(5);
    b.emit("longer than five");
    expect(b.emit("a")).toMatch(/reached their budget/);
  });

  it("measures BYTES, not characters", () => {
    const b = makeVaultBudget(4);
    // A two-byte-per-character string, written as escapes so this FILE holds no
    // non-ASCII bytes: three characters, six UTF-8 bytes, over a four-byte ceiling.
    const wide = "\u0448\u0448\u0448";
    expect(Buffer.byteLength(wide, "utf8")).toBe(6);
    expect(b.emit(wide)).toMatch(/reached their budget/);
  });

  it("counts what it let through, and nothing it refused", () => {
    const b = makeVaultBudget(10);
    b.emit("12345");
    expect(b.spentBytes()).toBe(5);
    b.emit("123456");
    // The refused result costs nothing: the exhausted sentence is not the vault's spend.
    expect(b.spentBytes()).toBe(5);
  });

  it("defaults to the turn ceiling", () => {
    const b = makeVaultBudget();
    expect(b.emit("x".repeat(VAULT_TURN_MAX_BYTES))).toHaveLength(VAULT_TURN_MAX_BYTES);
    expect(b.emit("x")).toMatch(/reached their budget/);
  });
});
