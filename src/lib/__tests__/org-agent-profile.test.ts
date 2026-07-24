import { describe, it, expect, vi, beforeEach } from "vitest";
import { ASSISTANT_PROFILE, RAW_PROFILE } from "@/lib/agents/profile";

// Only the settings table is stubbed — the JSON encoding, schema validation, and
// legacy seeding stay real, since those are what this covers.
const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    written: [] as { key: string; value: string }[],
    db: {
      select: () => ({
        from: () => ({
          where: (cond: { key?: string }) => ({
            limit: () => {
              const value = cond.key === undefined ? undefined : store.get(cond.key);
              return Promise.resolve(value === undefined ? [] : [{ key: cond.key, value, isEncrypted: false }]);
            },
          }),
        }),
      }),
      insert: () => ({
        values: (v: { key: string; value: string }) => ({
          onConflictDoUpdate: () => { store.set(v.key, v.value); h.written.push(v); return Promise.resolve(); },
        }),
      }),
    },
  };
});
// `eq` is what carries the key into the stubbed `where`, so it returns the key itself.
vi.mock("drizzle-orm", async (orig) => ({ ...(await orig<object>()), eq: (_col: unknown, key: string) => ({ key }) }));
vi.mock("@/lib/db", () => ({ db: h.db }));

import { getOrgAgentProfile, setOrgAgentProfile } from "@/lib/settings";

beforeEach(() => {
  h.store.clear();
  h.written.length = 0;
});

describe("org agent ceiling", () => {
  it("is fully permissive on an untouched instance", () => {
    // An instance that never opened the setting must behave exactly as before the
    // feature existed — the ceiling has to be a no-op by default.
    return expect(getOrgAgentProfile()).resolves.toEqual(ASSISTANT_PROFILE);
  });

  it("round-trips through the DB", async () => {
    await setOrgAgentProfile(RAW_PROFILE);
    expect(await getOrgAgentProfile()).toEqual(RAW_PROFILE);
  });

  it("validates on write, so the stored value is always readable back", async () => {
    await setOrgAgentProfile({ capabilities: { memory: false }, persona: "replace" });
    // Missing fields are filled from the schema defaults before storing.
    const stored = JSON.parse(h.written.at(-1)!.value);
    expect(stored.capabilities.sandbox).toBe(true);
    expect(stored.capabilities.memory).toBe(false);
    expect(stored.sessionContext).toBe(true);
    await expect(setOrgAgentProfile({ persona: "shout" })).rejects.toThrow();
  });

  it("seeds from the legacy keys so an existing admin's intent survives the upgrade", async () => {
    // `sandbox_enabled` shipped as a switch nothing read; honoring it now is what
    // makes it real, hence the breaking-change note in the changelog.
    h.store.set("sandbox_enabled", "false");
    h.store.set("memory_enabled", "false");

    const p = await getOrgAgentProfile();
    expect(p.capabilities.sandbox).toBe(false);
    expect(p.capabilities.memory).toBe(false);
    // Legacy seeding must not imply anything about the bits it never covered.
    expect(p.capabilities.connectors).toBe(true);
    expect(p.persona).toBe("append");
  });

  it("prefers the saved profile over the legacy keys, so there is one source of truth", async () => {
    h.store.set("sandbox_enabled", "false");
    await setOrgAgentProfile(ASSISTANT_PROFILE);
    expect((await getOrgAgentProfile()).capabilities.sandbox).toBe(true);
  });

  it("falls back to permissive on a corrupt value rather than clamping everyone to nothing", async () => {
    h.store.set("agent_profile", "{not json");
    expect(await getOrgAgentProfile()).toEqual(ASSISTANT_PROFILE);
  });
});
