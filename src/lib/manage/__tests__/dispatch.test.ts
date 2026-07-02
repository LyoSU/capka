import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createRegistry } from "../registry";
import { dispatch, applyPending, requiresApproval } from "../dispatch";
import { memPendingStore } from "./mem-pending";
import type { Control, ManageContext } from "../types";

/** An in-memory control backed by a mutable cell, so tests exercise the real
 *  dispatch flow (role gate, staged confirm, undo) without any DB. */
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

// One shared pending store per ctx() family so a stage() in one call can be
// consumed by applyPending() in the next — the human-authed apply path.
const store = memPendingStore();
function ctx(over: Partial<ManageContext> = {}): ManageContext {
  return { userId: "u1", isAdmin: false, projectId: null, pending: store, audit: vi.fn(), ...over };
}

describe("manage/dispatch", () => {
  it("list shows only user-role controls to a non-admin, all to an admin", async () => {
    const reg = createRegistry([
      memControl({ id: "user.locale", scope: "user", requiredRole: "user", risk: "safe" }).control,
      memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" }).control,
    ]);
    const asUser = await dispatch(reg, ctx(), { action: "list" });
    const asAdmin = await dispatch(reg, ctx({ isAdmin: true }), { action: "list" });
    const ids = (r: typeof asUser) =>
      r.status === "ok" ? (r.data as { settings: { id: string }[] }).settings.map((c) => c.id) : [];
    expect(ids(asUser)).toEqual(["user.locale"]);
    expect(ids(asAdmin)).toEqual(["user.locale", "org.net"]);
  });

  it("get on an enum control returns a choice card (options derived from the schema) with the current value marked", async () => {
    const { control } = memControl({
      id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm",
      schema: z.enum(["none", "bridge"]),
      format: (v) => (v === "bridge" ? "Network access" : "Isolated"),
    });
    control.read = async () => "none";
    const reg = createRegistry([control]);
    const res = await dispatch(reg, ctx({ isAdmin: true }), { action: "get", target: "org.net" });
    if (res.status !== "ok" || res.render !== "choice") throw new Error("expected choice render");
    const data = res.data as { value: string; options: { value: string; label: string }[] };
    expect(data.value).toBe("none");
    expect(data.options).toEqual([
      { value: "none", label: "Isolated" },
      { value: "bridge", label: "Network access" },
    ]);
  });

  it("get on a free-form control stays a plain value (no chips)", async () => {
    const { control } = memControl({ id: "org.name", scope: "org", requiredRole: "admin", risk: "confirm" }); // z.string()
    const reg = createRegistry([control]);
    const res = await dispatch(reg, ctx({ isAdmin: true }), { action: "get", target: "org.name" });
    expect(res.status === "ok" && res.render).toBe("value");
  });

  it("hides an admin control from a non-admin (get → not_found, no leak)", async () => {
    const reg = createRegistry([memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" }).control]);
    const res = await dispatch(reg, ctx(), { action: "get", target: "org.net" });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("not_found");
  });

  it("applies a safe user setting immediately and stages an undo", async () => {
    const { control, cell } = memControl({ id: "user.locale", scope: "user", requiredRole: "user", risk: "safe" });
    const reg = createRegistry([control]);
    const audit = vi.fn();
    const res = await dispatch(reg, ctx({ audit }), { action: "set", target: "user.locale", value: "uk" });
    expect(cell.value).toBe("uk");
    expect(res.status).toBe("ok");
    if (res.status === "ok" && res.render === "setting") {
      expect(res.data.before).toBe("user.locale:init");
      expect(res.data.after).toBe("uk");
      expect(res.data.undoPendingId).toBeTruthy();
    }
    expect(audit).toHaveBeenCalledOnce();
  });

  it("surfaces reloadOnApply on the setting result so the UI can refresh (e.g. after a locale change)", async () => {
    const plain = memControl({ id: "user.x", scope: "user", requiredRole: "user", risk: "safe" });
    const reloads = memControl({ id: "user.locale", scope: "user", requiredRole: "user", risk: "safe", reloadOnApply: true });
    const reg = createRegistry([plain.control, reloads.control]);
    const a = await dispatch(reg, ctx(), { action: "set", target: "user.x", value: "1" });
    const b = await dispatch(reg, ctx(), { action: "set", target: "user.locale", value: "uk" });
    if (a.status !== "ok" || a.render !== "setting") throw new Error("expected setting");
    if (b.status !== "ok" || b.render !== "setting") throw new Error("expected setting");
    expect(a.data.reload).toBeUndefined(); // ordinary settings don't force a refresh
    expect(b.data.reload).toBe(true);
  });

  // Forward confirm is now the AI SDK's native tool approval (see `requiresApproval`
  // + the tool's needsApproval): the SDK SUSPENDS a gated call before execute, so by
  // the time dispatch runs, the change is either ungated or already approved — it
  // applies directly. dispatch no longer stages a forward pending; only Undo does.
  it("requiresApproval gates a confirm-risk org change; dispatch then applies it directly", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    expect(await requiresApproval(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" })).toBe(true);
    const res = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    expect(res.status === "ok" && res.render).toBe("setting"); // applied, with an Undo
    expect(cell.value).toBe("bridge");
  });

  it("requiresApproval waives a PERSONAL confirm-risk change in autonomous mode (autonomy covers personal)", async () => {
    const auto = memControl({ id: "org.agent_autonomy", scope: "org", requiredRole: "admin", risk: "confirm" });
    auto.control.read = async () => "autonomous";
    const target = memControl({ id: "user.pref", scope: "user", requiredRole: "user", risk: "confirm" });
    const reg = createRegistry([auto.control, target.control]);
    expect(await requiresApproval(reg, ctx(), { action: "set", target: "user.pref", value: "x" })).toBe(false);
  });

  it("requiresApproval STILL gates a platform-wide (org) change in autonomous mode — blast radius > one user", async () => {
    const auto = memControl({ id: "org.agent_autonomy", scope: "org", requiredRole: "admin", risk: "confirm" });
    auto.control.read = async () => "autonomous";
    const target = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([auto.control, target.control]);
    expect(await requiresApproval(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" })).toBe(true);
  });

  it("requiresApproval STILL gates an alwaysConfirm control in autonomous mode (the master switch can't flip silently)", async () => {
    const auto = memControl({ id: "org.agent_autonomy", scope: "org", requiredRole: "admin", risk: "confirm", alwaysConfirm: true });
    auto.control.read = async () => "autonomous";
    const reg = createRegistry([auto.control]);
    expect(await requiresApproval(reg, ctx({ isAdmin: true }), { action: "set", target: "org.agent_autonomy", value: "supervised" })).toBe(true);
  });

  it("requiresApproval waives a safe change (no approval for a trivial personal pref)", async () => {
    const { control } = memControl({ id: "user.locale", scope: "user", requiredRole: "user", risk: "safe" });
    const reg = createRegistry([control]);
    expect(await requiresApproval(reg, ctx(), { action: "set", target: "user.locale", value: "uk" })).toBe(false);
  });

  // The pending store now backs only Undo — its safety semantics (single-use,
  // owner-scoped, role-rechecked) still matter, so exercise them via a real
  // undo pendingId (every applied set stages one).
  it("Undo restores via applyPending, and its pendingId is single-use", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const applied = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (applied.status !== "ok" || applied.render !== "setting") throw new Error("expected setting");
    const undoId = applied.data.undoPendingId!;
    expect(await store.peek(undoId, "u1")).toBe("open");
    const undone = await applyPending(reg, ctx({ isAdmin: true }), undoId);
    expect(undone.status).toBe("ok");
    expect(cell.value).toBe("org.net:init"); // restored
    expect(await store.peek(undoId, "u1")).toBe("applied");
    const again = await applyPending(reg, ctx({ isAdmin: true }), undoId); // single-use
    expect(again.status).toBe("error");
    if (again.status === "error") expect(again.code).toBe("confirm_expired");
  });

  it("an Undo staged by one user cannot be applied by another (owner-scoped)", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const applied = await dispatch(reg, ctx({ userId: "attacker", isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (applied.status !== "ok" || applied.render !== "setting") throw new Error("expected setting");
    const asVictim = await applyPending(reg, ctx({ userId: "victim", isAdmin: true }), applied.data.undoPendingId!);
    expect(asVictim.status).toBe("error");
    if (asVictim.status === "error") expect(asVictim.code).toBe("confirm_expired");
    expect(cell.value).toBe("bridge"); // undo refused → stays applied
  });

  it("applyPending re-checks the role at apply time (a demoted user can't apply an admin undo)", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const applied = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (applied.status !== "ok" || applied.render !== "setting") throw new Error("expected setting");
    const undone = await applyPending(reg, ctx({ isAdmin: false }), applied.data.undoPendingId!); // no longer admin
    expect(undone.status).toBe("error");
    expect(cell.value).toBe("bridge"); // undo refused → stays applied
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

  it("undo restores the previous value via its staged pendingId", async () => {
    const { control, cell } = memControl({ id: "user.locale", scope: "user", requiredRole: "user", risk: "safe" });
    const reg = createRegistry([control]);
    const applied = await dispatch(reg, ctx(), { action: "set", target: "user.locale", value: "uk" });
    if (applied.status !== "ok" || applied.render !== "setting") throw new Error("expected setting");
    expect(cell.value).toBe("uk");
    const undone = await applyPending(reg, ctx(), applied.data.undoPendingId!);
    expect(undone.status).toBe("ok");
    expect(cell.value).toBe("user.locale:init");
  });
});
