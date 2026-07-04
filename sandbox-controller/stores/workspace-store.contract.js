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
      const { entries } = await store.list("u1", "s1", ".");
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
      await expect(store.list("u1", "s1", ".")).resolves.toEqual({ entries: [], truncated: false });
    });

    it("delete() removes a single file, leaving the rest", async () => {
      await store.ensure("u1", "s1");
      await store.write("u1", "s1", "keep.txt", Buffer.from("k"));
      await store.write("u1", "s1", "drop.txt", Buffer.from("d"));
      await store.delete("u1", "s1", "drop.txt");
      const names = (await store.list("u1", "s1", ".")).entries.map((e) => e.name).sort();
      expect(names).toEqual(["keep.txt"]);
    });

    it("delete() is idempotent for a missing file", async () => {
      await store.ensure("u1", "s1");
      await expect(store.delete("u1", "s1", "ghost.txt")).resolves.toBeUndefined();
    });

    it("delete() removes a directory and its whole subtree (the quota-gate escape)", async () => {
      await store.ensure("u1", "s1");
      await store.write("u1", "s1", "keep.txt", Buffer.from("k"));
      await store.write("u1", "s1", "dir/inner.txt", Buffer.from("x"));
      await store.write("u1", "s1", "dir/sub/deep.txt", Buffer.from("y"));
      await store.delete("u1", "s1", "dir");
      const names = (await store.list("u1", "s1", ".")).entries.map((e) => e.name).sort();
      expect(names).toEqual(["keep.txt"]); // the folder and everything under it is gone
    });

    it("rejects path traversal", async () => {
      await store.ensure("u1", "s1");
      await expect(store.read("u1", "s1", "../../etc/passwd")).rejects.toBeTruthy();
    });

    it("isolates different sessions", async () => {
      await store.ensure("u1", "s1");
      await store.ensure("u1", "s2");
      await store.write("u1", "s1", "only-s1.txt", Buffer.from("x"));
      const { entries: s2 } = await store.list("u1", "s2", ".");
      expect(s2.map((e) => e.name)).not.toContain("only-s1.txt");
    });
  });
}
