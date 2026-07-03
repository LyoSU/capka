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

import { folderCollection, hostFolderEnabled, pcFolderLevel } from "../controls/folders";
import type { ManageContext } from "../types";

const admin = { userId: "u1", isAdmin: true, projectId: null, sessionKey: "s1", locale: "en" } as ManageContext;
const user = { userId: "u2", isAdmin: false, projectId: null, sessionKey: "s1", locale: "en" } as ManageContext;

// The two independent gates live under separate settings keys; make the getSetting
// mock key-aware so a test can set each one.
const setAccess = ({ host = "false", pc = "off" }: { host?: string; pc?: string }) => {
  h.getSetting.mockImplementation((k: string) => Promise.resolve(k === "host_folder_access" ? host : k === "pc_folder_access" ? pc : null));
};

beforeEach(() => {
  h.setRows([]);
  h.getSetting.mockReset();
  setAccess({});
  h.validateMount.mockReset().mockResolvedValue({ ok: true });
  h.createSession.mockClear();
});

describe("gate helpers", () => {
  it("hostFolderEnabled is a strict on/off, default off", async () => {
    setAccess({ host: "true" });
    expect(await hostFolderEnabled()).toBe(true);
    setAccess({ host: "garbage" });
    expect(await hostFolderEnabled()).toBe(false);
  });
  it("pcFolderLevel defaults off and passes through admins/everyone", async () => {
    setAccess({ pc: "garbage" });
    expect(await pcFolderLevel()).toBe("off");
    setAccess({ pc: "everyone" });
    expect(await pcFolderLevel()).toBe("everyone");
  });
});

describe("folder collection — gate", () => {
  it("both off → list and add both refuse", async () => {
    setAccess({ host: "false", pc: "off" });
    await expect(folderCollection.list(admin)).rejects.toThrow(/turned off/i);
    await expect(folderCollection.validateAdd!(admin, { kind: "pc" })).rejects.toThrow(/turned off/i);
  });

  it("pc admins-only + non-admin → pc add refused", async () => {
    setAccess({ pc: "admins" });
    await expect(folderCollection.validateAdd!(user, { kind: "pc" })).rejects.toThrow(/administrator/i);
  });

  it("canAdd: reflects the two independent gates", async () => {
    setAccess({ host: "false", pc: "admins" });
    expect(await folderCollection.canAdd!(admin)).toBe(true);   // admin via pc-admins
    expect(await folderCollection.canAdd!(user)).toBe(false);   // user blocked at pc-admins
    setAccess({ host: "false", pc: "everyone" });
    expect(await folderCollection.canAdd!(user)).toBe(true);    // user via pc-everyone
    setAccess({ host: "true", pc: "off" });
    expect(await folderCollection.canAdd!(admin)).toBe(true);   // admin via host
    expect(await folderCollection.canAdd!(user)).toBe(false);   // host is admin-only
    setAccess({ host: "false", pc: "off" });
    expect(await folderCollection.canAdd!(admin)).toBe(false);  // both off
  });
});

describe("folder collection — host add", () => {
  it("refuses a non-admin even with server folders enabled", async () => {
    setAccess({ host: "true", pc: "everyone" });
    await expect(folderCollection.validateAdd!(user, { path: "/srv/reports" })).rejects.toThrow(/administrator/i);
  });

  it("refuses when server folders are disabled, even for an admin", async () => {
    setAccess({ host: "false" });
    await expect(folderCollection.validateAdd!(admin, { path: "/srv/reports" })).rejects.toThrow(/turned off/i);
  });

  it("rejects an invalid path via the controller before any row is written", async () => {
    setAccess({ host: "true" });
    h.validateMount.mockResolvedValue({ ok: false, code: "denied" });
    await expect(folderCollection.validateAdd!(admin, { path: "/etc" })).rejects.toThrow(/system location/i);
    expect(h.getRows()).toHaveLength(0);
  });

  it("rejects a duplicate name", async () => {
    setAccess({ host: "true" });
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
  it("pc add hands back a folder picker WITHOUT creating a row (the browser POSTs after picking)", async () => {
    setAccess({ pc: "everyone" });
    const r = await folderCollection.add!(user, { kind: "pc", name: "My Docs" });
    expect(r.action?.kind).toBe("pick_folder");
    expect(h.getRows()).toHaveLength(0); // row is created by /api/folders after the pick
    expect(h.createSession).not.toHaveBeenCalled(); // pc folders never recreate the sandbox
  });

  it("remove deletes the row", async () => {
    setAccess({ pc: "everyone" });
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
