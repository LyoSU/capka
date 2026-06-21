import { describe, it, expect, beforeEach, afterEach } from "vitest";

/** Shared behavioral contract every WorkspaceStore implementation must satisfy.
 *  @param {() => ({ store: any, cleanup: () => Promise<void> })} makeStore */
export function runWorkspaceStoreContract(makeStore) {
  describe("WorkspaceStore contract", () => {
    let store, cleanup;
    beforeEach(() => { ({ store, cleanup } = makeStore()); });
    afterEach(async () => { await cleanup?.(); });

    it("ensure() creates workspace + shared paths", async () => {
      const { wsHostPath, sharedHostPath } = await store.ensure("u1", "s1");
      expect(typeof wsHostPath).toBe("string");
      expect(typeof sharedHostPath).toBe("string");
      // idempotent
      await expect(store.ensure("u1", "s1")).resolves.toBeTruthy();
    });

    it("write() then read() round-trips bytes", async () => {
      await store.ensure("u1", "s1");
      await store.write("u1", "s1", "hello.txt", Buffer.from("hi"));
      const chunks = [];
      for await (const c of await store.read("u1", "s1", "hello.txt")) chunks.push(c);
      expect(Buffer.concat(chunks).toString()).toBe("hi");
    });

    it("list() returns written entries", async () => {
      await store.ensure("u1", "s1");
      await store.write("u1", "s1", "a.txt", Buffer.from("x"));
      const entries = await store.list("u1", "s1", ".");
      expect(entries.map((e) => e.name)).toContain("a.txt");
    });

    it("size() reflects written bytes", async () => {
      await store.ensure("u1", "s1");
      await store.write("u1", "s1", "a.bin", Buffer.alloc(100));
      expect(await store.size("u1", "s1")).toBeGreaterThanOrEqual(100);
    });

    it("remove() deletes the workspace", async () => {
      await store.ensure("u1", "s1");
      await store.write("u1", "s1", "a.txt", Buffer.from("x"));
      await store.remove("u1", "s1");
      await expect(store.list("u1", "s1", ".")).resolves.toEqual([]);
    });

    it("rejects path traversal", async () => {
      await store.ensure("u1", "s1");
      await expect(store.read("u1", "s1", "../../etc/passwd")).rejects.toBeTruthy();
    });

    it("isolates different sessions", async () => {
      await store.ensure("u1", "s1");
      await store.ensure("u1", "s2");
      await store.write("u1", "s1", "only-s1.txt", Buffer.from("x"));
      const s2 = await store.list("u1", "s2", ".");
      expect(s2.map((e) => e.name)).not.toContain("only-s1.txt");
    });
  });
}
