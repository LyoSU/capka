import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createRegistry } from "../registry";
import { dispatch } from "../dispatch";
import type { Control, ManageContext } from "../types";

const SECRET = "0123456789abcdef0123456789abcdef";

/** An in-memory control backed by a mutable cell, so tests exercise the real
 *  dispatch flow (role gate, confirm token, undo) without any DB. */
function memControl(over: Partial<Control> & Pick<Control, "id" | "scope" | "requiredRole" | "risk">): {
  control: Control;
  cell: { value: string };
} {
  const cell = { value: over.id + ":init" };
  const control: Control = {
    title: over.id,
    description: "",
    schema: z.string(),
    read: async () => cell.value,
    apply: async (_ctx, v) => { cell.value = v; },
    ...over,
  } as Control;
  return { control, cell };
}

function ctx(over: Partial<ManageContext> = {}): ManageContext {
  return { userId: "u1", isAdmin: false, projectId: null, secret: SECRET, audit: vi.fn(), ...over };
}

describe("manage/dispatch", () => {
  it("list shows only user-role controls to a non-admin, all to an admin", async () => {
    const reg = createRegistry([
      memControl({ id: "user.locale", scope: "user", requiredRole: "user", risk: "safe" }).control,
      memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" }).control,
    ]);
    const asUser = await dispatch(reg, ctx(), { action: "list" });
    const asAdmin = await dispatch(reg, ctx({ isAdmin: true }), { action: "list" });
    const ids = (r: typeof asUser) => (r.status === "ok" ? (r.data as { id: string }[]).map((c) => c.id) : []);
    expect(ids(asUser)).toEqual(["user.locale"]);
    expect(ids(asAdmin)).toEqual(["user.locale", "org.net"]);
  });

  it("hides an admin control from a non-admin (get → not_found, no leak)", async () => {
    const reg = createRegistry([memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" }).control]);
    const res = await dispatch(reg, ctx(), { action: "get", target: "org.net" });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("not_found");
  });

  it("applies a safe user setting immediately and returns an undo token", async () => {
    const { control, cell } = memControl({ id: "user.locale", scope: "user", requiredRole: "user", risk: "safe" });
    const reg = createRegistry([control]);
    const audit = vi.fn();
    const res = await dispatch(reg, ctx({ audit }), { action: "set", target: "user.locale", value: "uk" });
    expect(cell.value).toBe("uk");
    expect(res.status).toBe("ok");
    if (res.status === "ok" && res.render === "setting") {
      expect(res.data.before).toBe("user.locale:init");
      expect(res.data.after).toBe("uk");
      expect(res.data.undoToken).toBeTruthy();
    }
    expect(audit).toHaveBeenCalledOnce();
  });

  it("does NOT apply a confirm-risk change on the first call — returns confirm_required + token", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const res = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    expect(cell.value).toBe("org.net:init"); // unchanged
    expect(res.status).toBe("confirm_required");
    if (res.status === "confirm_required") {
      expect(res.confirmToken).toBeTruthy();
      expect(res.preview.after).toBe("bridge");
    }
  });

  it("applies the confirm-risk change on the second call with a matching token", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const first = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (first.status !== "confirm_required") throw new Error("expected confirm_required");
    const second = await dispatch(reg, ctx({ isAdmin: true }), {
      action: "set", target: "org.net", value: "bridge", confirmToken: first.confirmToken,
    });
    expect(second.status).toBe("ok");
    expect(cell.value).toBe("bridge");
  });

  it("rejects a confirm token issued for a DIFFERENT value (no bait-and-switch)", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const first = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (first.status !== "confirm_required") throw new Error("expected confirm_required");
    const swapped = await dispatch(reg, ctx({ isAdmin: true }), {
      action: "set", target: "org.net", value: "none", confirmToken: first.confirmToken,
    });
    expect(swapped.status).toBe("error");
    if (swapped.status === "error") expect(swapped.code).toBe("confirm_invalid");
    expect(cell.value).toBe("org.net:init");
  });

  it("rejects a confirm token minted by a different user", async () => {
    const { control } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const first = await dispatch(reg, ctx({ userId: "attacker", isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (first.status !== "confirm_required") throw new Error("expected confirm_required");
    const asVictim = await dispatch(reg, ctx({ userId: "victim", isAdmin: true }), {
      action: "set", target: "org.net", value: "bridge", confirmToken: first.confirmToken,
    });
    expect(asVictim.status).toBe("error");
    if (asVictim.status === "error") expect(asVictim.code).toBe("confirm_invalid");
  });

  it("refuses a non-admin setting an admin control even with a value (not_found, unchanged)", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const res = await dispatch(reg, ctx(), { action: "set", target: "org.net", value: "bridge" });
    expect(res.status).toBe("error");
    expect(cell.value).toBe("org.net:init");
  });

  it("rejects a value that fails the control schema", async () => {
    const { control, cell } = memControl({
      id: "org.net", scope: "org", requiredRole: "admin", risk: "safe",
      schema: z.enum(["none", "bridge"]),
    });
    const reg = createRegistry([control]);
    const res = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "wifi" });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("invalid_value");
    expect(cell.value).toBe("org.net:init");
  });

  it("undoes a change with a valid undo token", async () => {
    const { control, cell } = memControl({ id: "user.locale", scope: "user", requiredRole: "user", risk: "safe" });
    const reg = createRegistry([control]);
    const applied = await dispatch(reg, ctx(), { action: "set", target: "user.locale", value: "uk" });
    if (applied.status !== "ok" || applied.render !== "setting") throw new Error("expected setting");
    expect(cell.value).toBe("uk");
    const undone = await dispatch(reg, ctx(), { action: "undo", undoToken: applied.data.undoToken! });
    expect(undone.status).toBe("ok");
    expect(cell.value).toBe("user.locale:init");
  });

  it("rejects an undo token minted by a different user", async () => {
    const { control, cell } = memControl({ id: "user.locale", scope: "user", requiredRole: "user", risk: "safe" });
    const reg = createRegistry([control]);
    const applied = await dispatch(reg, ctx({ userId: "u1" }), { action: "set", target: "user.locale", value: "uk" });
    if (applied.status !== "ok" || applied.render !== "setting") throw new Error("expected setting");
    const undone = await dispatch(reg, ctx({ userId: "u2" }), { action: "undo", undoToken: applied.data.undoToken! });
    expect(undone.status).toBe("error");
    expect(cell.value).toBe("uk");
  });
});
