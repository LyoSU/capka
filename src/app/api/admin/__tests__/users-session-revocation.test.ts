import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessions } from "@/lib/db/schema";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  audit: vi.fn(),
  transaction: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  removeWhere: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireAdmin: mocks.requireAdmin };
});

vi.mock("@/lib/governance/audit", () => ({ audit: mocks.audit }));

vi.mock("@/lib/db", () => ({
  db: {
    transaction: mocks.transaction,
  },
}));

import { PUT } from "@/app/api/admin/users/route";

describe("admin user status changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ userId: "admin-1", role: "admin", status: "active" });
    mocks.update.mockReturnValue({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([{ id: "user-1", status: "pending", name: "User", email: "u@example.com" }]),
        }),
      }),
    });
    mocks.remove.mockReturnValue({ where: mocks.removeWhere.mockResolvedValue(undefined) });
    mocks.transaction.mockImplementation(async (callback) => callback({ update: mocks.update, delete: mocks.remove }));
  });

  it("revokes every session atomically when an account is deactivated", async () => {
    const response = await PUT(new Request("http://localhost/api/admin/users", {
      method: "PUT",
      body: JSON.stringify({ userId: "user-1", status: "pending" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledWith(sessions);
    expect(mocks.removeWhere).toHaveBeenCalledOnce();
  });

  it("keeps sessions when an account is activated", async () => {
    const response = await PUT(new Request("http://localhost/api/admin/users", {
      method: "PUT",
      body: JSON.stringify({ userId: "user-1", status: "active" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
