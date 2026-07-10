import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run lease.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "lease-test-user";
const OTHER = "lease-other-user";
const FID = "lease-test-folder";

const { requireActive } = vi.hoisted(() => ({ requireActive: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireActive };
});

const params = Promise.resolve({ id: FID });

run("folder sync lease", () => {
  beforeAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'L','lease@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'O','lease-other@test.local') ON CONFLICT (id) DO NOTHING`, [OTHER]);
  });
  afterAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM attached_folders WHERE id = $1`, [FID]);
    await pool.query(`DELETE FROM "user" WHERE id IN ($1,$2)`, [U, OTHER]);
  });

  async function freshFolder() {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM attached_folders WHERE id = $1`, [FID]);
    await pool.query(
      `INSERT INTO attached_folders (id, user_id, session_key, kind, name) VALUES ($1,$2,'sk','pc','f')`,
      [FID, U],
    );
    requireActive.mockImplementation(() => Promise.resolve({ userId: U, role: "user", status: "active" }));
  }

  it("acquires, blocks a concurrent acquire (409), then re-acquires after release", async () => {
    await freshFolder();
    const { POST, DELETE } = await import("../route");

    const a = await POST(new Request("http://x", { method: "POST" }), { params });
    expect(a.status).toBe(200);
    const { token } = (await a.json()) as { token: string };
    expect(token).toBeTruthy();

    // A second sync (another tab) must be refused while the lease is live.
    const b = await POST(new Request("http://x", { method: "POST" }), { params });
    expect(b.status).toBe(409);

    // Releasing with the wrong token must NOT free it.
    await DELETE(new Request("http://x?token=wrong", { method: "DELETE" }), { params });
    const stillHeld = await POST(new Request("http://x", { method: "POST" }), { params });
    expect(stillHeld.status).toBe(409);

    // Releasing with the real token frees it for the next sync.
    const rel = await DELETE(new Request(`http://x?token=${token}`, { method: "DELETE" }), { params });
    expect(rel.status).toBe(200);
    const c = await POST(new Request("http://x", { method: "POST" }), { params });
    expect(c.status).toBe(200);
  });

  it("an expired lease is treated as free", async () => {
    await freshFolder();
    const { pool } = await import("@/lib/db");
    await pool.query(
      `UPDATE attached_folders SET sync_lease = jsonb_build_object('token','stale','expiresAt', to_char(now() - interval '1 hour','YYYY-MM-DD"T"HH24:MI:SS"Z"')) WHERE id = $1`,
      [FID],
    );
    const { POST } = await import("../route");
    const a = await POST(new Request("http://x", { method: "POST" }), { params });
    expect(a.status).toBe(200);
  });

  it("refuses a folder that isn't the caller's (404)", async () => {
    await freshFolder();
    requireActive.mockImplementation(() => Promise.resolve({ userId: OTHER, role: "user", status: "active" }));
    const { POST } = await import("../route");
    const a = await POST(new Request("http://x", { method: "POST" }), { params });
    expect(a.status).toBe(404);
  });

  it("refuses a pending account (403) — requireActive gate", async () => {
    await freshFolder();
    requireActive.mockImplementation(() => Promise.reject(new ForbiddenError("pending")));
    const { POST } = await import("../route");
    const a = await POST(new Request("http://x", { method: "POST" }), { params });
    expect(a.status).toBe(403);
  });
});
