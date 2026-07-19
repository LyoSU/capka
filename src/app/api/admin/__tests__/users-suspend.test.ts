import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessions } from "@/lib/db/schema";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  audit: vi.fn(),
  transaction: vi.fn(),
  update: vi.fn(),
  select: vi.fn(),
  del: vi.fn(),
  txUpdate: vi.fn(),
  txSelect: vi.fn(),
  txDelete: vi.fn(),
  txDeleteWhere: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireAdmin: mocks.requireAdmin };
});
vi.mock("@/lib/governance/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/billing/limits", () => ({ getLimitStatus: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    transaction: mocks.transaction,
    update: mocks.update,
    select: mocks.select,
    delete: mocks.del,
  },
}));

import { PUT } from "@/app/api/admin/users/route";

const row = { id: "user-1", status: "suspended", role: "user", tierId: "t2", name: "User", email: "u@example.com" };
const updateChain = (returning: unknown[]) => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(returning) }) }) });
const selectChain = (rows: unknown[]) => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) });

const put = (body: unknown) =>
  PUT(new Request("http://localhost/api/admin/users", { method: "PUT", body: JSON.stringify(body) }));

describe("admin user suspend / reactivate / tier lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ userId: "admin-1", role: "admin", status: "active" });
    mocks.txDelete.mockReturnValue({ where: mocks.txDeleteWhere.mockResolvedValue(undefined) });
    mocks.txUpdate.mockReturnValue(updateChain([row]));
    // The route reads the PRIOR status inside the transaction (it decides
    // suspend vs reactivate vs plain status_change in the audit trail).
    mocks.txSelect.mockReturnValue(selectChain([{ status: "active" }]));
    mocks.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ update: mocks.txUpdate, select: mocks.txSelect, delete: mocks.txDelete }));
    mocks.update.mockReturnValue(updateChain([row]));
    mocks.select.mockReturnValue(selectChain([{ id: "t2", name: "User", email: "u@example.com" }]));
    mocks.del.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  });

  it("suspends: flips status AND revokes every session in one transaction", async () => {
    const res = await put({ userId: "user-1", status: "suspended" });
    expect(res.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.txDelete).toHaveBeenCalledWith(sessions);
    expect(mocks.txDeleteWhere).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user.suspend", targetKey: "user-1", detail: expect.objectContaining({ status: "suspended" }) }),
    );
  });

  it("reactivates: flips to active WITHOUT revoking sessions", async () => {
    mocks.txSelect.mockReturnValue(selectChain([{ status: "suspended" }]));
    mocks.txUpdate.mockReturnValue(updateChain([{ ...row, status: "active" }]));
    const res = await put({ userId: "user-1", status: "active" });
    expect(res.status).toBe(200);
    expect(mocks.txDelete).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "user.reactivate" }));
  });

  it("approving a pending signup stays a plain status_change", async () => {
    mocks.txSelect.mockReturnValue(selectChain([{ status: "pending" }]));
    mocks.txUpdate.mockReturnValue(updateChain([{ ...row, status: "active" }]));
    const res = await put({ userId: "user-1", status: "active" });
    expect(res.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "user.status_change" }));
  });

  it("rejects an unknown status", async () => {
    const res = await put({ userId: "user-1", status: "banned" });
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses to let an admin change their own account", async () => {
    const res = await put({ userId: "admin-1", status: "suspended" });
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("assigns a personal tier and audits it", async () => {
    mocks.update.mockReturnValue(updateChain([{ id: "user-1", tierId: "t2", name: "User", email: "u@example.com" }]));
    const res = await put({ userId: "user-1", tierId: "t2" });
    expect(res.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user.tier_change", targetType: "user", targetKey: "user-1", detail: expect.objectContaining({ tierId: "t2" }) }),
    );
  });

  it("clears a tier back to the instance default (null)", async () => {
    mocks.update.mockReturnValue(updateChain([{ id: "user-1", tierId: null, name: "User", email: "u@example.com" }]));
    const res = await put({ userId: "user-1", tierId: null });
    expect(res.status).toBe(200);
  });

  it("force-revokes all sessions without changing status", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    mocks.del.mockReturnValue({ where });
    const res = await put({ userId: "user-1", revokeSessions: true });
    expect(res.status).toBe(200);
    expect(mocks.del).toHaveBeenCalledWith(sessions);
    expect(where).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user.sessions_revoke", targetKey: "user-1" }),
    );
  });
});
