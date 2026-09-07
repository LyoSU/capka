import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The bulk-upload route is the other write a sync makes through the API, and it used
 * to accept whatever arrived. A batch is assembled over seconds of file reads, so the
 * client's own check can always be overtaken between its last look and this request —
 * and a stale tab whose lease lapsed long ago was writing into the folder unopposed.
 *
 * So a batch that names a lease has to still hold it, on the same condition the
 * ancestor swap uses. Naming no lease is unchanged: the one-shot fallback import has
 * no folder row to check against.
 */

const { requireActive } = vi.hoisted(() => ({ requireActive: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireActive };
});
vi.mock("@/lib/manage/controls/folders", () => ({
  pcFolderLevel: () => Promise.resolve("everyone"),
  canAttachPc: () => true,
}));
vi.mock("@/lib/rate-limit", () => ({ take: () => ({ ok: true }) }));
vi.mock("@/lib/sandbox/target", () => ({
  resolveWorkspaceTarget: () => Promise.resolve({ sessionKey: "sk-1" }),
}));

const h = vi.hoisted(() => {
  let held = true;
  const calls: { sql: string; params: unknown[] }[] = [];
  const uploaded: string[] = [];
  return {
    calls, uploaded,
    /** Whether the row still carries a live lease for the token asked about. */
    setHeld: (v: boolean) => { held = v; },
    reset: () => { calls.length = 0; uploaded.length = 0; held = true; },
    pool: {
      query: (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: held ? [{ one: 1 }] : [], rowCount: held ? 1 : 0 });
      },
    },
    uploadFile: (_key: string, dir: string, file: File): Promise<void> => {
      uploaded.push(`${dir}/${file.name}`);
      return Promise.resolve();
    },
  };
});
vi.mock("@/lib/db", () => ({ pool: h.pool }));
vi.mock("@/lib/sandbox/client", () => ({ uploadFile: h.uploadFile }));

import { POST } from "@/app/api/folders/upload/route";

/** One upload request for "docs", optionally naming a lease token. */
function req(lease?: string): Request {
  const form = new FormData();
  form.append("chatId", "c1");
  form.append("name", "docs");
  if (lease) form.append("lease", lease);
  form.append("files", new File(["hello"], "a.txt"));
  return new Request("http://x/api/folders/upload", { method: "POST", body: form });
}

beforeEach(() => {
  h.reset();
  requireActive.mockReset().mockResolvedValue({ userId: "u1", role: "user", status: "active" });
});

describe("POST /api/folders/upload — the sync lease fence", () => {
  it("accepts a batch whose lease is still live, and says which row it checked", async () => {
    const r = await POST(req("t1"));
    expect(r.status).toBe(200);
    const [check] = h.calls;
    expect(check.sql).toMatch(/FROM attached_folders WHERE session_key = \$1 AND name = \$2/);
    expect(check.sql).toMatch(/sync_lease->>'token' = \$3/);
    expect(check.sql).toMatch(/\(sync_lease->>'expiresAt'\)::timestamptz > now\(\)/);
    expect(check.params).toEqual(["sk-1", "docs", "t1"]);
    expect(h.uploaded).toEqual(["docs/a.txt"]);
  });

  // Wrong token and expired lease are the same answer from the database: no row
  // matched. Either way this run no longer owns the folder, so nothing may be written.
  it("409s a batch whose lease is wrong or expired, and writes nothing", async () => {
    h.setHeld(false);
    const r = await POST(req("stale"));
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("LEASE_GONE");
    expect(h.uploaded).toEqual([]);
  });

  it("leaves a batch that names no lease exactly as it was — no check, no refusal", async () => {
    const r = await POST(req());
    expect(r.status).toBe(200);
    expect(h.calls).toEqual([]);
    expect(h.uploaded).toEqual(["docs/a.txt"]);
  });
});
