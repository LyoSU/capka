import { describe, it, expect, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";

// Keep apiHandler + the real error classes so a thrown ForbiddenError maps to 403;
// stub only the auth gate. requireActive is the gate under test: a pending/rejected
// account must be refused BEFORE any handler body runs. (vi.hoisted because the
// mock factory is lifted above imports and can't close over a plain const.)
const { requireActive } = vi.hoisted(() => ({ requireActive: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireActive };
});
// db is only reached on the happy path; a chainable stub that resolves to no rows.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
  },
}));

import { GET } from "@/app/api/automations/route";
import { PATCH, DELETE } from "@/app/api/automations/[id]/route";

const params = Promise.resolve({ id: "a1" });

describe("automations routes — require an ACTIVE account (not just a session)", () => {
  it("a pending/rejected account is refused (403) on list, enable/disable, and delete", async () => {
    // mockImplementation (not mockRejectedValue) so the rejected promise is created
    // per-call at await time — avoids vitest flagging an eager unhandled rejection.
    requireActive.mockImplementation(() => Promise.reject(new ForbiddenError("Your account is awaiting administrator approval.")));

    const list = await GET();
    expect(list.status).toBe(403);

    const patch = await PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ enabled: true }) }), { params });
    expect(patch.status).toBe(403);

    const del = await DELETE(new Request("http://x", { method: "DELETE" }), { params });
    expect(del.status).toBe(403);
  });

  it("an active account passes the gate and reaches the handler", async () => {
    requireActive.mockImplementation(() => Promise.resolve({ userId: "u1", role: "user", status: "active" }));
    const list = await GET();
    expect(list.status).toBe(200);
    expect(requireActive).toHaveBeenCalled();
  });
});
