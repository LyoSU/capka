import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createRegistry } from "../registry";
import { dispatch } from "../dispatch";
import type { Collection, CollectionItem, ManageContext } from "../types";

const SECRET = "0123456789abcdef0123456789abcdef";

function ctx(over: Partial<ManageContext> = {}): ManageContext {
  return { userId: "u1", isAdmin: false, projectId: null, secret: SECRET, audit: vi.fn(), ...over };
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

  it("add is confirm-gated: first call previews, does not add", async () => {
    const { collection, items } = memCollection();
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "add", target: "mcp", args: { name: "grok", url: "https://x" } });
    expect(res.status).toBe("confirm_required");
    expect(items).toHaveLength(1);
  });

  it("add applies on the confirmed second call and surfaces a follow-up action", async () => {
    const { collection, items } = memCollection();
    const reg = createRegistry([], [collection]);
    const first = await dispatch(reg, ctx(), { action: "add", target: "mcp", args: { name: "grok", url: "https://x" } });
    if (first.status !== "confirm_required") throw new Error("expected confirm");
    const second = await dispatch(reg, ctx(), {
      action: "add", target: "mcp", args: { name: "grok", url: "https://x" }, confirmToken: first.confirmToken,
    });
    expect(second.status).toBe("ok");
    expect(items).toHaveLength(2);
    if (second.status === "ok" && second.render === "resource") {
      expect(second.data.op).toBe("added");
      expect(second.data.action?.kind).toBe("oauth");
    }
  });

  it("rejects an add value that fails the collection's addSchema", async () => {
    const { collection } = memCollection();
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "add", target: "mcp", args: { name: "grok" } });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("invalid_value");
  });

  it("enable/disable apply directly", async () => {
    const { collection, items } = memCollection();
    const reg = createRegistry([], [collection]);
    const res = await dispatch(reg, ctx(), { action: "disable", target: "mcp", itemId: "s1" });
    expect(res.status).toBe("ok");
    expect(items[0].enabled).toBe(false);
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

  it("remove is confirm-gated and then removes", async () => {
    const { collection, items } = memCollection();
    const reg = createRegistry([], [collection]);
    const first = await dispatch(reg, ctx(), { action: "remove", target: "mcp", itemId: "s1" });
    if (first.status !== "confirm_required") throw new Error("expected confirm");
    expect(items).toHaveLength(1);
    const second = await dispatch(reg, ctx(), { action: "remove", target: "mcp", itemId: "s1", confirmToken: first.confirmToken });
    expect(second.status).toBe("ok");
    expect(items).toHaveLength(0);
  });
});
