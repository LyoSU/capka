import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { sync } from "../bridge";
import type { DirHandle, FileHandle } from "../local-fs";
import type { Manifest } from "../plan";
import { chatTarget } from "@/lib/workspace-target";

/**
 * The whole sync, against a folder held in memory and a fake of the routes it calls:
 * the lease, the workspace listing, the stored merge ancestor (revision CAS + lease
 * token, like the real UPDATE), the upload, the download and the delete. What is
 * pinned is what reaches either side, not the order of lines in the source.
 */

// ── An in-memory folder behind the File System Access handle shape ───────────
type FileNode = { kind: "file"; data: Blob; mtime: number };
type DirNode = { kind: "dir"; children: Map<string, FileNode | DirNode> };
let clock = 1;
const notFound = () => new DOMException("not found", "NotFoundError");

function fileHandle(name: string, node: FileNode): FileHandle {
  return {
    kind: "file",
    name,
    getFile: async () => new File([node.data], name, { lastModified: node.mtime }),
    createWritable: async () => {
      let next = new Blob([]);
      return {
        write: async (d) => { next = new Blob([d]); },
        close: async () => { node.data = next; node.mtime = clock++; },
      };
    },
  };
}

function dirHandle(name: string, node: DirNode): DirHandle {
  return {
    kind: "directory",
    name,
    async *entries() {
      for (const [n, c] of node.children) yield [n, c.kind === "dir" ? dirHandle(n, c) : fileHandle(n, c)];
    },
    getDirectoryHandle: async (n, opts) => {
      let c = node.children.get(n);
      if (!c && opts?.create) node.children.set(n, c = { kind: "dir", children: new Map() });
      if (c?.kind !== "dir") throw notFound();
      return dirHandle(n, c);
    },
    getFileHandle: async (n, opts) => {
      let c = node.children.get(n);
      if (!c && opts?.create) node.children.set(n, c = { kind: "file", data: new Blob([]), mtime: clock++ });
      if (c?.kind !== "file") throw notFound();
      return fileHandle(n, c);
    },
    removeEntry: async (n) => { if (!node.children.delete(n)) throw notFound(); },
  };
}

/** A folder holding `paths`, each file's text its own path. */
function computer(paths: string[]) {
  const root: DirNode = { kind: "dir", children: new Map() };
  for (const p of paths) {
    const parts = p.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.children.get(part);
      if (!next) dir.children.set(part, next = { kind: "dir", children: new Map() });
      dir = next as DirNode;
    }
    dir.children.set(parts.at(-1)!, { kind: "file", data: new Blob([p]), mtime: clock++ });
  }
  const files = (node: DirNode = root, prefix = ""): string[] => [...node.children].flatMap(([n, c]) =>
    c.kind === "dir" ? files(c, `${prefix}${n}/`) : [`${prefix}${n}`]);
  return { handle: dirHandle("docs", root), files: () => files().sort() };
}

// ── The routes ───────────────────────────────────────────────────────────────
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
type Row = { v: 1; rev: number; files: Manifest; dirs: string[] };

/** `copy` is the workspace's copy of the folder (null: not there at all); `listing`
 *  answers the workspace read with an error or a cut-short tree instead. */
function server(opts: { row: Row | null; copy: Map<string, string> | null; listing?: "error" | "truncated"; failUploadChunk?: number }) {
  let { row, copy } = opts;
  const calls: string[] = [];
  const deleted: string[] = [];
  let uploads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://capka.test");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    const rel = (u.searchParams.get("path") ?? "").replace(/^docs\/?/, "");
    switch (`${method} ${u.pathname}`) {
      case "POST /api/folders/f1/lease":
        return Response.json({ token: "tok", expiresAt: new Date(Date.now() + 300_000).toISOString() });
      case "PATCH /api/folders/f1/lease":
      case "DELETE /api/folders/f1/lease":
        return Response.json({ ok: true });
      case "GET /api/sandbox/files": {
        if (opts.listing === "error") return Response.json({ error: "boom" }, { status: 500 });
        if (!copy) return Response.json({ entries: [], truncated: false, missing: true });
        const dirs = new Set([...copy.keys()].flatMap((p) => p.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
        return Response.json({
          entries: [
            ...[...dirs].map((d) => ({ path: `docs/${d}`, isDirectory: true, size: 0, modifiedAt: null })),
            ...[...copy].map(([p, text]) => ({ path: `docs/${p}`, isDirectory: false, size: text.length, modifiedAt: null, hash: sha(text) })),
          ],
          truncated: opts.listing === "truncated",
        });
      }
      case "GET /api/sandbox/files/download":
        return new Response(copy!.get(rel)!);
      case "DELETE /api/sandbox/files":
        deleted.push(rel);
        copy?.delete(rel);
        return Response.json({ ok: true });
      case "GET /api/folders/f1/state":
        return Response.json({ state: row });
      case "PUT /api/folders/f1/state": {
        const { expectedRev, state } = JSON.parse(init!.body as string);
        if (u.searchParams.get("token") !== "tok" || (row?.rev ?? 0) !== expectedRev) return Response.json({}, { status: 409 });
        row = state;
        return Response.json({ ok: true });
      }
      case "POST /api/folders/upload": {
        if (++uploads === opts.failUploadChunk) return new Response(null, { status: 500 });
        copy ??= new Map();
        for (const f of (init!.body as FormData).getAll("files") as File[]) copy.set(f.name, await f.text());
        return Response.json({ ok: true });
      }
    }
    throw new Error(`unexpected ${method} ${url}`);
  }));
  return { calls, deleted, row: () => row, copy: () => copy };
}

const run = (pc: ReturnType<typeof computer>) =>
  sync(chatTarget("c1"), { id: "f1", name: "docs" }, undefined, async () => pc.handle);
/** The ancestor a completed sync of exactly `paths` would have stored. */
const ancestorOf = (paths: string[]): Row => ({
  v: 1, rev: 4, files: Object.fromEntries(paths.map((p) => [p, { mtime: 0, size: p.length, hash: sha(p) }])),
  dirs: [...new Set(paths.flatMap((p) => p.split("/").slice(0, -1)))],
});
// 150 files over three folders: two upload chunks.
const PATHS = Array.from({ length: 150 }, (_, i) => `d${i % 3}/f${i}.txt`).sort();

afterEach(() => vi.unstubAllGlobals());

describe("sync — a missing workspace copy is put back, never read as deletions", () => {
  it("stores the empty ancestor before the first upload, then the full one at the end", async () => {
    const pc = computer(PATHS);
    const srv = server({ row: ancestorOf(PATHS), copy: null });

    const out = await run(pc);

    const puts = srv.calls.flatMap((c, i) => (c === "PUT /api/folders/f1/state" ? [i] : []));
    expect(puts).toHaveLength(2);
    expect(puts[0]).toBeLessThan(srv.calls.indexOf("POST /api/folders/upload"));
    expect(pc.files()).toEqual(PATHS);
    expect([...srv.copy()!.keys()].sort()).toEqual(PATHS);
    expect(srv.deleted).toEqual([]);
    expect(srv.row()).toMatchObject({ rev: 6 });
    expect(Object.keys(srv.row()!.files).sort()).toEqual(PATHS);
    expect(out.synced).toBe(150);
  });

  it("leaves the next sync a union when the re-upload is cut short", async () => {
    const pc = computer(PATHS);
    const srv = server({ row: ancestorOf(PATHS), copy: null, failUploadChunk: 2 });

    await expect(run(pc)).rejects.toThrow("upload failed");
    // What the cut-short run left: the reset ancestor, and a copy of the first chunk only.
    expect(srv.row()).toEqual({ v: 1, rev: 5, files: {}, dirs: [] });
    const partial = new Map(srv.copy());
    expect(partial.size).toBe(100);

    // The next sync sees a copy again, holding only part of the files.
    const next = server({ row: srv.row(), copy: partial });
    await run(pc);
    expect(pc.files()).toEqual(PATHS);
    expect(next.deleted).toEqual([]);
    expect([...next.copy()!.keys()].sort()).toEqual(PATHS);
  });

  it("would delete what the re-upload had not reached, against the old ancestor (control)", async () => {
    const pc = computer(PATHS);
    const partial = new Map(PATHS.slice(0, 100).map((p) => [p, p]));
    server({ row: ancestorOf(PATHS), copy: partial });

    await run(pc);

    expect(pc.files()).toEqual(PATHS.slice(0, 100));
  });
});

describe("sync — a workspace it could not read in full deletes nothing", () => {
  it.each(["error", "truncated"] as const)("stops before any write when the listing comes back %s", async (listing) => {
    const pc = computer(PATHS);
    const srv = server({ row: ancestorOf(PATHS), copy: new Map([["d0/f0.txt", "d0/f0.txt"]]), listing });

    await expect(run(pc)).rejects.toThrow(/workspace/);

    expect(pc.files()).toEqual(PATHS);
    expect(srv.deleted).toEqual([]);
    expect(srv.calls.filter((c) => c.startsWith("PUT ") || c.endsWith("/upload"))).toEqual([]);
    expect(srv.row()).toMatchObject({ rev: 4 });
  });
});
