import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The webhook route is the only entry point in the app with NO session, so the
 * things asserted here are the things nothing else can catch:
 *  - every refusal is the SAME 404, so the URL cannot be used as an oracle for
 *    whether a token exists or what state an account is in;
 *  - an ineligible owner/project is switched off HERE (the scheduler never sees
 *    a webhook row, so it is the only place that can);
 *  - the body is bounded, quoted, and de-duplicated by Idempotency-Key.
 *
 * `fireAutomation` is mocked: what a firing does is covered by runs.integration,
 * and what this route owes it is only "the raw body, unmodified".
 */

const state = vi.hoisted(() => ({
  automations: [] as Record<string, unknown>[],
  users: [] as Record<string, unknown>[],
  projects: [] as Record<string, unknown>[],
  /** What the delivery-key insert returns: a row = claimed, empty = duplicate. */
  insertReturns: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  deletes: 0,
}));

const { fireAutomation, getSetting } = vi.hoisted(() => ({
  fireAutomation: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const rowsFor = (table: unknown) =>
    table === schema.automations ? state.automations
      : table === schema.users ? state.users
        : table === schema.projects ? state.projects
          : [];
  return {
    db: {
      select: () => ({ from: (t: unknown) => ({ where: () => Promise.resolve(rowsFor(t)) }) }),
      update: () => ({
        set: (v: Record<string, unknown>) => ({ where: () => { state.updated.push(v); return Promise.resolve(); } }),
      }),
      delete: () => ({ where: () => { state.deletes += 1; return Promise.resolve(); } }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve(state.insertReturns) }) }),
      }),
    },
  };
});
vi.mock("@/lib/settings", () => ({ getSetting }));
vi.mock("@/lib/automations/runs", () => ({ fireAutomation }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "@/app/api/hooks/automations/[token]/route";

const call = (opts: { body?: string; headers?: Record<string, string>; token?: string } = {}) =>
  POST(
    new Request("http://x/api/hooks/automations/tok", {
      method: "POST",
      body: opts.body ?? "{}",
      headers: opts.headers,
    }),
    { params: Promise.resolve({ token: opts.token ?? "tok" }) },
  );

const ENABLED_ROW = {
  id: "a1", userId: "u1", projectId: null, enabled: true, webhookToken: "tok",
  title: "Inbox digest", prompt: "Summarize it", threadMode: "fresh", maxRunsPerDay: null,
  trigger: { kind: "webhook", timezone: "Europe/Kyiv" },
};

beforeEach(() => {
  state.automations = [{ ...ENABLED_ROW }];
  state.users = [{ status: "active" }];
  state.projects = [{ id: "p1" }];
  state.insertReturns = [{ idempotencyKey: "k" }];
  state.updated = [];
  state.deletes = 0;
  fireAutomation.mockReset().mockResolvedValue({ fired: true, chatId: "c1" });
  getSetting.mockReset().mockResolvedValue("true");
});

describe("POST /api/hooks/automations/[token] — refusals are indistinguishable", () => {
  it("answers an unknown token with the same 404 body as every other refusal", async () => {
    state.automations = [];
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(fireAutomation).not.toHaveBeenCalled();
  });

  it("answers a paused automation with that identical 404", async () => {
    state.automations = [{ ...ENABLED_ROW, enabled: false }];
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(fireAutomation).not.toHaveBeenCalled();
  });

  it("answers a suspended owner with that identical 404 AND switches the row off with the reason", async () => {
    state.users = [{ status: "suspended" }];
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    // The scheduler never ticks a webhook row, so this route is the only thing
    // that can record why it stopped — a silent 404 would leave the owner with a
    // dead endpoint and no explanation anywhere.
    expect(state.updated).toEqual([expect.objectContaining({ enabled: false, disabledReason: "owner_suspended" })]);
    expect(fireAutomation).not.toHaveBeenCalled();
  });

  it("answers a deleted project with that identical 404 and records project_deleted", async () => {
    state.automations = [{ ...ENABLED_ROW, projectId: "p1" }];
    state.projects = [];
    const res = await call();
    expect(res.status).toBe(404);
    expect(state.updated).toEqual([expect.objectContaining({ enabled: false, disabledReason: "project_deleted" })]);
  });

  it("answers with that identical 404 while automations are switched off platform-wide, and leaves the row enabled", async () => {
    getSetting.mockResolvedValue("false");
    const res = await call();
    expect(res.status).toBe(404);
    // A platform-wide stop is temporary: flipping the switch back has to resume
    // the automation, so nothing may be written to the row here.
    expect(state.updated).toEqual([]);
    expect(fireAutomation).not.toHaveBeenCalled();
  });
});

describe("POST /api/hooks/automations/[token] — bounds", () => {
  it("refuses an oversized body by its declared length, without reading it", async () => {
    const res = await call({ headers: { "content-length": String(300 * 1024) } });
    expect(res.status).toBe(413);
    expect(fireAutomation).not.toHaveBeenCalled();
  });

  it("refuses an oversized body that declared nothing", async () => {
    const res = await call({ body: "x".repeat(256 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect(fireAutomation).not.toHaveBeenCalled();
  });

  it("refuses an over-long Idempotency-Key before any lookup, so the answer says nothing about the token", async () => {
    const res = await call({ headers: { "idempotency-key": "k".repeat(201) } });
    expect(res.status).toBe(400);
    // Nothing was read: an unknown token and a real one answer identically here.
    expect(state.updated).toEqual([]);
    expect(fireAutomation).not.toHaveBeenCalled();
  });
});

describe("POST /api/hooks/automations/[token] — outcomes are 202 with a status", () => {
  it("accepts a firing and returns the chat it landed in", async () => {
    const res = await call({ body: '{"a":1}' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted", chatId: "c1" });
    // The route's whole contract toward the run: the body, byte for byte. The
    // quoting and the untrusted mark are runs.ts's job, deliberately not this
    // route's, so there is exactly one place that decides what "untrusted" means.
    expect(fireAutomation).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), { rawBody: '{"a":1}' });
  });

  it("reports a repeat of the same Idempotency-Key as a duplicate WITHOUT firing", async () => {
    state.insertReturns = []; // the insert conflicted — this key was already seen
    const res = await call({ headers: { "idempotency-key": "evt-1" } });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "duplicate" });
    expect(fireAutomation).not.toHaveBeenCalled();
    // The 24h window is only real because the prune ran before the insert.
    expect(state.deletes).toBe(1);
  });

  it("reports the daily limit as a skip with its reason, not as a failure", async () => {
    fireAutomation.mockResolvedValue({ fired: false, reason: "daily_limit" });
    const res = await call();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "skipped", reason: "daily_limit" });
  });

  it("reports a live previous run as a skip with reason busy", async () => {
    fireAutomation.mockResolvedValue({ fired: false, reason: "busy" });
    const res = await call();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "skipped", reason: "busy" });
  });

  it("releases the delivery key when the firing throws, so the sender's retry is a first attempt", async () => {
    fireAutomation.mockRejectedValue(new Error("db blip"));
    const res = await call({ headers: { "idempotency-key": "evt-2" } });
    expect(res.status).toBe(500);
    // Two deletes: the 24h prune, then the release of the key we had claimed.
    expect(state.deletes).toBe(2);
  });
});
