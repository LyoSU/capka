import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createRegistry } from "../registry";
import { dispatch, requiresApproval, preview } from "../dispatch";
import { memPendingStore } from "./mem-pending";
import type { Collection, CollectionItem, Control, ManageContext } from "../types";

const store = memPendingStore();
function ctx(over: Partial<ManageContext> = {}): ManageContext {
  return { userId: "u1", isAdmin: false, projectId: null, pending: store, audit: vi.fn(), ...over };
}

/** In-memory MCP-like collection so the collection dispatch paths are exercised
 *  without a database. */
function memCollection(over: Partial<Collection> = {}): { collection: Collection; items: CollectionItem[] } {
  const items: CollectionItem[] = [{ id: "s1", title: "existing", enabled: true, owned: true }];
  const collection: Collection = {
    id: "mcp",
    title: "Connectors",
    description: "",
    requiredRole: "user",
    auditNoun: "connector",
    addSchema: z.object({ name: z.string(), url: z.string() }),
    list: async () => items,
    previewAdd: (_ctx, args) => ({ title: "Connectors", after: String(args.name) }),
    add: async (_ctx, args) => {
      items.push({ id: `s${items.length + 1}`, title: String(args.name) });
      return { itemTitle: String(args.name), action: { kind: "oauth", url: "/api/mcp/oauth/start?serverId=x", label: "Connect" } };
    },
    remove: async (_ctx, itemId) => {
      const i = items.findIndex((x) => x.id === itemId);
      const [removed] = items.splice(i, 1);
      return { itemTitle: removed?.title ?? itemId };
    },
    setEnabled: async (_ctx, itemId, enabled) => {
      const it = items.find((x) => x.id === itemId)!;
      it.enabled = enabled;
      return { itemTitle: it.title };
    },
    debug: async (_ctx, itemId) => ({ itemTitle: itemId, state: "unauthorized", hint: "Sign in again." }),
    connect: async (_ctx, itemId) => ({ kind: "oauth", url: `/api/mcp/oauth/start?serverId=${itemId}`, label: "Connect" }),
    ...over,
  };
  return { collection, items };
}

describe("manage/dispatch collections", () => {
  it("get on a collection id lists its items", async () => {
    const { collection } = memCollection();
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "get", target: "mcp" });
    expect(res.status).toBe("ok");
    if (res.status === "ok" && res.render === "collection") {
      expect(res.data.items.map((i) => i.id)).toEqual(["s1"]);
    } else {
      throw new Error("expected collection render");
    }
  });

  it("surfaces settingsPath so the card can link to the full settings page (#12)", async () => {
    const { collection } = memCollection({ settingsPath: "/settings/skills?tab=connectors" });
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "get", target: "mcp" });
    if (res.status === "ok" && res.render === "collection") {
      expect(res.data.settingsPath).toBe("/settings/skills?tab=connectors");
    } else {
      throw new Error("expected collection render");
    }
  });

  it("get resolves and surfaces the collection's canAdd (authoritative, not inferred by the model)", async () => {
    const { collection } = memCollection({ canAdd: async () => true });
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "get", target: "mcp" });
    if (res.status === "ok" && res.render === "collection") {
      expect(res.data.canAdd).toBe(true);
    } else {
      throw new Error("expected collection render");
    }
  });

  it("canAdd defaults to the coarse role check when the collection omits it", async () => {
    const { collection } = memCollection(); // no canAdd, requiredRole "user"
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "get", target: "mcp" });
    if (res.status === "ok" && res.render === "collection") {
      expect(res.data.canAdd).toBe(true); // a non-admin may add to a user-role collection
    } else {
      throw new Error("expected collection render");
    }
  });

  it("list surfaces canAdd per collection", async () => {
    const { collection } = memCollection({ canAdd: async () => false });
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "list" });
    if (res.status === "ok" && res.render === "list") {
      const data = res.data as { collections: { id: string; canAdd: boolean }[] };
      expect(data.collections[0].canAdd).toBe(false);
    } else {
      throw new Error("expected list render");
    }
  });

  it("requiresApproval gates an add unless autonomous (the SDK suspends the call, not dispatch)", async () => {
    const { collection } = memCollection();
    const reg = createRegistry([], [collection]);
    // No org.agent_autonomy control registered → not autonomous → gated.
    expect(await requiresApproval(reg, ctx(), { action: "add", target: "mcp", args: { name: "grok", url: "https://x" } })).toBe(true);
  });

  it("preview() carries an async previewAdd's probe details (Responds — N tools) for the approval card", async () => {
    const { collection } = memCollection({
      // Simulates a network probe run before the approval card is shown (#11).
      previewAdd: async (_ctx, args) => ({ title: "Connectors", after: String(args.name), details: "Responds — 4 tools available." }),
    });
    const reg = createRegistry([], [collection]);
    const pv = await preview(reg, ctx(), { action: "add", target: "mcp", args: { name: "grok", url: "https://x" } });
    expect(pv?.details).toBe("Responds — 4 tools available.");
  });

  it("add (post-approval) applies directly via dispatch and surfaces a follow-up action", async () => {
    const { collection, items } = memCollection();
    const reg = createRegistry([], [collection]);
    const applied = await dispatch(reg, ctx(), { action: "add", target: "mcp", args: { name: "grok", url: "https://x" } });
    expect(applied.status).toBe("ok");
    expect(items).toHaveLength(2);
    if (applied.status === "ok" && applied.render === "resource") {
      expect(applied.data.op).toBe("added");
      expect(applied.data.action?.kind).toBe("oauth");
    }
  });

  it("rejects an add value that fails the collection's addSchema", async () => {
    const { collection } = memCollection();
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "add", target: "mcp", args: { name: "grok" } });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("invalid_value");
  });

  it("validateAdd refuses UP FRONT — a doomed add never reaches a confirm card", async () => {
    const { collection, items } = memCollection({
      validateAdd: async () => { throw new Error("only an admin can add this"); },
    });
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "add", target: "mcp", args: { name: "x", url: "https://y" } });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.summary).toBe("only an admin can add this");
    expect(items).toHaveLength(1); // nothing added
  });

  it("audit action is derived from the collection's auditNoun (a skill is logged as skill.*, not connector.*)", async () => {
    const audit = vi.fn();
    const { collection } = memCollection({ auditNoun: "skill" });
    const reg = createRegistry([], [collection]);
    await dispatch(reg, ctx({ audit }), { action: "add", target: "mcp", args: { name: "s", url: "https://y" } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "skill.add" }));
  });

  it("a failed audit write does not fail an already-applied change (best-effort)", async () => {
    const audit = vi.fn().mockRejectedValue(new Error("audit backend down"));
    const { collection, items } = memCollection();
    const reg = createRegistry([], [collection]);
    const applied = await dispatch(reg, ctx({ audit }), { action: "add", target: "mcp", args: { name: "s", url: "https://y" } });
    expect(applied.status).toBe("ok"); // the add succeeded despite the audit failure
    expect(items).toHaveLength(2);
  });

  it("disable applies directly — turning an item OFF is safety-positive, never gated", async () => {
    const { collection, items } = memCollection({ confirmEnable: true });
    const reg = createRegistry([], [collection]);
    expect(await requiresApproval(reg, ctx(), { action: "disable", target: "mcp", itemId: "s1" })).toBe(false);
    const res = await dispatch(reg, ctx(), { action: "disable", target: "mcp", itemId: "s1" });
    expect(res.status).toBe("ok");
    expect(items[0].enabled).toBe(false);
  });

  it("requiresApproval gates enable ONLY when the collection opts in via confirmEnable", async () => {
    const gated = createRegistry([], [memCollection({ confirmEnable: true }).collection]);
    const plain = createRegistry([], [memCollection().collection]); // no confirmEnable
    expect(await requiresApproval(gated, ctx(), { action: "enable", target: "mcp", itemId: "s1" })).toBe(true);
    expect(await requiresApproval(plain, ctx(), { action: "enable", target: "mcp", itemId: "s1" })).toBe(false);
  });

  it("the enable gate SURVIVES autonomous mode (activating third-party code is the one checkpoint injection can't bypass)", async () => {
    // Register an autonomy control that reports the org is autonomous — which lets
    // a bare `remove`/`disable` through, but must NOT let a confirmEnable enable through.
    const autonomy: Control = {
      id: "org.agent_autonomy", title: "", description: "", scope: "org", requiredRole: "admin",
      risk: "safe", schema: z.string(), read: async () => "autonomous", apply: async () => {},
    };
    const reg = createRegistry([autonomy], [memCollection({ confirmEnable: true }).collection]);
    expect(await requiresApproval(reg, ctx(), { action: "enable", target: "mcp", itemId: "s1" })).toBe(true);
    // Sanity: disable is still direct even here.
    expect(await requiresApproval(reg, ctx(), { action: "disable", target: "mcp", itemId: "s1" })).toBe(false);
  });

  it("preview() for a gated enable shows a Disabled→Enabled diff with the impact warning", async () => {
    const { collection, items } = memCollection({ confirmEnable: true, enableImpact: "Runs third-party code once enabled." });
    items[0].enabled = false; // a disabled item the agent wants to turn on
    const reg = createRegistry([], [collection]);
    const pv = await preview(reg, ctx(), { action: "enable", target: "mcp", itemId: "s1" });
    expect(pv?.title).toContain("existing");
    expect(pv?.before).toBe("Disabled");
    expect(pv?.after).toBe("Enabled");
    expect(pv?.impact).toBe("Runs third-party code once enabled.");
  });

  it("enable (post-approval) applies exactly once via dispatch", async () => {
    const { collection, items } = memCollection({ confirmEnable: true });
    items[0].enabled = false;
    const reg = createRegistry([], [collection]);
    const applied = await dispatch(reg, ctx(), { action: "enable", target: "mcp", itemId: "s1" });
    expect(applied.status).toBe("ok");
    expect(items[0].enabled).toBe(true);
  });

  it("debug returns a debug render with state + hint", async () => {
    const { collection } = memCollection();
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "debug", target: "mcp", itemId: "s1" });
    expect(res.status).toBe("ok");
    if (res.status === "ok" && res.render === "debug") {
      expect(res.data.state).toBe("unauthorized");
      expect(res.data.hint).toBeTruthy();
    } else {
      throw new Error("expected debug render");
    }
  });

  it("connect returns action_required with an OAuth url", async () => {
    const { collection } = memCollection();
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "connect", target: "mcp", itemId: "s1" });
    expect(res.status).toBe("action_required");
    if (res.status === "action_required") {
      expect(res.action.kind).toBe("oauth");
      expect(res.action.url).toContain("serverId=s1");
    }
  });

  it("hides an admin-only collection from a non-admin", async () => {
    const { collection } = memCollection({ requiredRole: "admin" });
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "get", target: "mcp" });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("not_found");
  });

  it("requiresApproval gates a remove unless autonomous, then dispatch removes directly", async () => {
    const { collection, items } = memCollection();
    const reg = createRegistry([], [collection]);
    expect(await requiresApproval(reg, ctx(), { action: "remove", target: "mcp", itemId: "s1" })).toBe(true);
    const applied = await dispatch(reg, ctx(), { action: "remove", target: "mcp", itemId: "s1" });
    expect(applied.status).toBe("ok");
    expect(items).toHaveLength(0);
  });
});
