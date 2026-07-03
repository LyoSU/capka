import { describe, it, expect, vi, beforeEach } from "vitest";

// Compact fakes: an in-memory `db` whose query chains ignore the predicate (each
// test seeds exactly the rows it needs), plus the settings + controller seams.
const h = vi.hoisted(() => {
  let rows: Record<string, unknown>[] = [];
  const thenable = (getter: () => Record<string, unknown>[]): unknown => {
    const p = Promise.resolve().then(getter);
    return Object.assign(p, {
      where: () => thenable(getter),
      limit: (n: number) => Promise.resolve(getter().slice(0, n)),
    });
  };
  const db = {
    select: () => ({ from: () => thenable(() => rows.map((r) => ({ ...r }))) }),
    insert: () => ({ values: (v: Record<string, unknown>) => { rows.push({ ...v }); return Promise.resolve(); } }),
    delete: () => ({ where: () => { rows = []; return Promise.resolve(); } }),
  };
  return {
    db,
    setRows: (r: Record<string, unknown>[]) => { rows = r; },
    getRows: () => rows,
    getSetting: vi.fn(),
    validateMount: vi.fn(),
    createSession: vi.fn().mockResolvedValue({}),
    getSandboxNetworkDefault: vi.fn().mockResolvedValue("none"),
  };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/settings", () => ({ getSetting: h.getSetting, getSandboxNetworkDefault: h.getSandboxNetworkDefault }));
vi.mock("@/lib/sandbox/client", () => ({ validateMount: h.validateMount, createSession: h.createSession }));

import { folderCollection, folderAccessLevel } from "../controls/folders";
import type { ManageContext } from "../types";

const admin = { userId: "u1", isAdmin: true, projectId: null, sessionKey: "s1", locale: "en" } as ManageContext;
const user = { userId: "u2", isAdmin: false, projectId: null, sessionKey: "s1", locale: "en" } as ManageContext;

beforeEach(() => {
  h.setRows([]);
  h.getSetting.mockReset();
  h.validateMount.mockReset().mockResolvedValue({ ok: true });
  h.createSession.mockClear();
});

describe("folderAccessLevel", () => {
  it("defaults to off for any unrecognized value", async () => {
    h.getSetting.mockResolvedValue(null);
    expect(await folderAccessLevel()).toBe("off");
    h.getSetting.mockResolvedValue("garbage");
    expect(await folderAccessLevel()).toBe("off");
  });
  it("passes through admins/everyone", async () => {
    h.getSetting.mockResolvedValue("everyone");
    expect(await folderAccessLevel()).toBe("everyone");
  });
});

describe("folder collection — gate", () => {
  it("off → list and add both refuse", async () => {
    h.getSetting.mockResolvedValue("off");
    await expect(folderCollection.list(admin)).rejects.toThrow(/turned off/i);
    await expect(folderCollection.validateAdd!(admin, { kind: "pc" })).rejects.toThrow(/turned off/i);
  });

  it("admins-only + non-admin → pc add refused", async () => {
    h.getSetting.mockResolvedValue("admins");
    await expect(folderCollection.validateAdd!(user, { kind: "pc" })).rejects.toThrow(/administrator/i);
  });

  it("canAdd: admin always, regular user only at 'everyone'", async () => {
    h.getSetting.mockResolvedValue("admins");
    expect(await folderCollection.canAdd!(admin)).toBe(true);
    expect(await folderCollection.canAdd!(user)).toBe(false);
    h.getSetting.mockResolvedValue("everyone");
    expect(await folderCollection.canAdd!(user)).toBe(true);
    h.getSetting.mockResolvedValue("off");
    expect(await folderCollection.canAdd!(admin)).toBe(false);
  });
});

describe("folder collection — host add", () => {
  it("refuses a non-admin even at 'everyone'", async () => {
    h.getSetting.mockResolvedValue("everyone");
    await expect(folderCollection.validateAdd!(user, { path: "/srv/reports" })).rejects.toThrow(/administrator/i);
  });

  it("rejects an invalid path via the controller before any row is written", async () => {
    h.getSetting.mockResolvedValue("admins");
    h.validateMount.mockResolvedValue({ ok: false, code: "denied" });
    await expect(folderCollection.validateAdd!(admin, { path: "/etc" })).rejects.toThrow(/system location/i);
    expect(h.getRows()).toHaveLength(0);
  });

  it("rejects a duplicate name", async () => {
    h.getSetting.mockResolvedValue("admins");
    h.setRows([{ name: "reports", sessionKey: "s1", kind: "host" }]);
    await expect(folderCollection.validateAdd!(admin, { path: "/srv/reports" })).rejects.toThrow(/already attached/i);
  });

  it("previewAdd states the path, mount target, read/write mode, and restart", () => {
    const rw = folderCollection.previewAdd!(admin, { path: "/srv/reports", readOnly: "false" }) as { after: string; impact?: string };
    expect(rw.after).toContain("/srv/reports");
    expect(rw.after).toContain("/folders/reports");
    expect(rw.after).toContain("read-write");
    expect(rw.impact).toMatch(/restart/i);
    const ro = folderCollection.previewAdd!(admin, { path: "/srv/reports" }) as { after: string };
    expect(ro.after).toContain("read-only");
  });
});

describe("folder collection — pc add + remove", () => {
  it("pc add inserts a read-write row and hands back a folder picker", async () => {
    h.getSetting.mockResolvedValue("everyone");
    const r = await folderCollection.add!(user, { kind: "pc", name: "My Docs" });
    expect(r.action?.kind).toBe("pick_folder");
    const [row] = h.getRows();
    expect(row).toMatchObject({ kind: "pc", name: "mydocs", readOnly: false, sessionKey: "s1", userId: "u2" });
    expect(h.createSession).not.toHaveBeenCalled(); // pc folders never recreate the sandbox
  });

  it("remove deletes the row", async () => {
    h.getSetting.mockResolvedValue("everyone");
    h.setRows([{ id: "f1", name: "docs", sessionKey: "s1", kind: "pc", userId: "u2", readOnly: false }]);
    const r = await folderCollection.remove!(user, "f1");
    expect(r.itemTitle).toBe("docs");
    expect(h.getRows()).toHaveLength(0);
  });

  it("remove refuses a folder from another session", async () => {
    h.setRows([{ id: "f1", name: "docs", sessionKey: "other", kind: "pc", userId: "u2" }]);
    await expect(folderCollection.remove!(user, "f1")).rejects.toThrow(/no such folder/i);
  });
});
