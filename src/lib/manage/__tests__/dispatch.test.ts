import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createRegistry } from "../registry";
import { dispatch, applyPending } from "../dispatch";
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

  it("does NOT apply a confirm-risk change — it STAGES one and returns a pendingId; the model can't apply it", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const res = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    expect(cell.value).toBe("org.net:init"); // unchanged — nothing applied
    expect(res.status).toBe("confirm_required");
    if (res.status === "confirm_required") {
      expect(res.pendingId).toBeTruthy();
      expect(res.preview.after).toBe("bridge");
    }
    // There is NO model-facing action to apply — set/add/remove only stage.
  });

  it("autonomous mode applies a confirm-risk change directly, no card", async () => {
    const auto = memControl({ id: "org.agent_autonomy", scope: "org", requiredRole: "admin", risk: "confirm" });
    auto.control.read = async () => "autonomous";
    const target = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([auto.control, target.control]);
    const res = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    expect(target.cell.value).toBe("bridge"); // applied directly, not staged
    expect(res.status === "ok" && res.render).toBe("setting");
  });

  it("autonomous mode STILL confirms an alwaysConfirm control (the autonomy master switch can't be flipped silently)", async () => {
    const auto = memControl({ id: "org.agent_autonomy", scope: "org", requiredRole: "admin", risk: "confirm", alwaysConfirm: true });
    auto.control.read = async () => "autonomous";
    const reg = createRegistry([auto.control]);
    const res = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.agent_autonomy", value: "supervised" });
    expect(res.status).toBe("confirm_required");
    expect(auto.cell.value).toBe("org.agent_autonomy:init"); // unchanged — still gated
  });

  it("applyPending applies exactly the staged change (human-authed path)", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const staged = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (staged.status !== "confirm_required") throw new Error("expected confirm_required");
    const applied = await applyPending(reg, ctx({ isAdmin: true }), staged.pendingId);
    expect(applied.status).toBe("ok");
    expect(cell.value).toBe("bridge");
  });

  it("a confirmed pending reads back as 'applied' (so a reloaded card shows done, not live buttons)", async () => {
    const { control } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const staged = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (staged.status !== "confirm_required") throw new Error("expected confirm_required");
    expect(await store.peek(staged.pendingId, "u1")).toBe("open");
    await applyPending(reg, ctx({ isAdmin: true }), staged.pendingId);
    expect(await store.peek(staged.pendingId, "u1")).toBe("applied");
  });

  it("a cancelled pending can no longer be applied (web Cancel drops it server-side)", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const staged = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (staged.status !== "confirm_required") throw new Error("expected confirm_required");
    await store.cancel(staged.pendingId, "u1"); // what the DELETE endpoint does
    expect(await store.peek(staged.pendingId, "u1")).toBe("gone");
    const applied = await applyPending(reg, ctx({ isAdmin: true }), staged.pendingId);
    expect(applied.status).toBe("error");
    if (applied.status === "error") expect(applied.code).toBe("confirm_expired");
    expect(cell.value).toBe("org.net:init"); // never applied
  });

  it("a pendingId is single-use — a second apply is refused", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const staged = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (staged.status !== "confirm_required") throw new Error("expected confirm_required");
    await applyPending(reg, ctx({ isAdmin: true }), staged.pendingId);
    cell.value = "none"; // pretend something changed it back
    const again = await applyPending(reg, ctx({ isAdmin: true }), staged.pendingId);
    expect(again.status).toBe("error");
    if (again.status === "error") expect(again.code).toBe("confirm_expired");
    expect(cell.value).toBe("none"); // not re-applied
  });

  it("a pending staged by one user cannot be applied by another (no cross-user apply)", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const staged = await dispatch(reg, ctx({ userId: "attacker", isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (staged.status !== "confirm_required") throw new Error("expected confirm_required");
    const asVictim = await applyPending(reg, ctx({ userId: "victim", isAdmin: true }), staged.pendingId);
    expect(asVictim.status).toBe("error");
    if (asVictim.status === "error") expect(asVictim.code).toBe("confirm_expired");
    expect(cell.value).toBe("org.net:init");
  });

  it("applyPending re-checks the role at apply time (a demoted user can't apply an admin change)", async () => {
    const { control, cell } = memControl({ id: "org.net", scope: "org", requiredRole: "admin", risk: "confirm" });
    const reg = createRegistry([control]);
    const staged = await dispatch(reg, ctx({ isAdmin: true }), { action: "set", target: "org.net", value: "bridge" });
    if (staged.status !== "confirm_required") throw new Error("expected confirm_required");
    const applied = await applyPending(reg, ctx({ isAdmin: false }), staged.pendingId); // no longer admin
    expect(applied.status).toBe("error");
    expect(cell.value).toBe("org.net:init");
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
