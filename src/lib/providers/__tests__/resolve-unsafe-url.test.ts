import { describe, it, expect, vi } from "vitest";

/**
 * A saved connection whose URL the SSRF guard now refuses — the strict private-URL
 * policy switched on after it was saved, or a host that stopped resolving — must
 * reach /api/chat as the resolver's ValidationError, which the route answers with
 * MODEL_UNAVAILABLE (and the admin pointer). The guard's own UnsafeUrlError is not
 * an AppError, so it used to escape as a 500 with nothing to act on.
 */
vi.mock("@/lib/settings", () => ({
  getAuxModelRef: vi.fn(async () => null),
  getMasterKey: vi.fn(async () => "k"),
  sharedKeyEnabled: vi.fn(async () => false),
  getModelMaxPrice: vi.fn(async () => 0),
  getModelMinContext: vi.fn(async () => 0),
  // The strict policy: a private address is refused.
  getBlockPrivateProviderUrls: vi.fn(async () => true),
}));
const row = vi.hoisted(() => ({
  id: "cfg-local",
  userId: "u1",
  provider: "openai",
  baseUrl: "http://127.0.0.1:4000/v1",
  apiKey: null,
  apiStyle: null,
  defaultModel: "m1",
  isActive: true,
}));
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }) },
}));

import { resolveUserModelInfo } from "../resolve";
import { isAppError } from "@/lib/errors";

describe("resolveUserModelInfo — a connection the URL guard refuses", () => {
  it("refuses with a ValidationError, not a bare error the route turns into a 500", async () => {
    const err = await resolveUserModelInfo("u1", "cfg-local:m1").catch((e: unknown) => e);
    expect(isAppError(err) && err.code).toBe("VALIDATION_ERROR");
    expect((err as Error).message).toMatch(/address isn't allowed/);
  });
});
