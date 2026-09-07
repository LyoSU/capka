import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The row is inserted BEFORE the realtime wake-up is sent. So a wake that throws
 * used to reject `enqueueTask` for a turn that already exists and will run — and
 * every caller reads that rejection as "the enqueue did not happen" and releases
 * the budget hold it reserved (the chat route, Telegram, an automation, the
 * runner's late-steer follow-up). The 5-second poll then picks the row up and runs
 * it with no reservation at all: the budget gate bypassed by the error handling
 * meant to protect it.
 */
const publish = vi.hoisted(() => vi.fn());
const execute = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/realtime", () => ({ realtime: { publish } }));
vi.mock("@/lib/db", () => ({ db: { execute }, pool: { query: vi.fn() } }));
vi.mock("@/lib/log", () => ({ log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { enqueueTask } = await import("../queue");

beforeEach(() => {
  publish.mockReset();
  execute.mockReset();
  warn.mockReset();
});

const task = { id: "t-new", chatId: "c1", userId: "u1", payload: {} };

describe("enqueueTask's wake-up is best-effort", () => {
  it("still reports the created turn when the wake-up fails", async () => {
    execute.mockResolvedValue({ rows: [{ id: "t-new", created: true }] });
    publish.mockRejectedValue(new Error("NOTIFY failed: connection terminated"));

    // Resolves, and says the row was created — so the caller hands the hold to the
    // turn rather than releasing it under a turn that is about to run.
    await expect(enqueueTask(task)).resolves.toEqual({ id: "t-new", created: true });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("says so in the log rather than swallowing it silently", async () => {
    execute.mockResolvedValue({ rows: [{ id: "t-new", created: true }] });
    publish.mockRejectedValue(new Error("NOTIFY failed"));
    await enqueueTask(task);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/wake-up failed/);
  });

  it("wakes a worker on the happy path, and only for a turn it created", async () => {
    execute.mockResolvedValue({ rows: [{ id: "t-new", created: true }] });
    publish.mockResolvedValue(undefined);
    await expect(enqueueTask(task)).resolves.toEqual({ id: "t-new", created: true });
    expect(publish).toHaveBeenCalledWith("task_enqueued", { id: "t-new" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends no wake-up for a message that folded into an existing turn", async () => {
    // A folded message rides a turn a worker will already pick up.
    execute.mockResolvedValue({ rows: [{ id: "t-incumbent", created: false }] });
    await expect(enqueueTask(task)).resolves.toEqual({ id: "t-incumbent", created: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it("sends no wake-up from inside a caller's transaction", async () => {
    // It rides a separate connection, so a worker woken before the commit would look
    // for a row no other connection can see; those callers await notifyTaskEnqueued.
    const tx = { execute } as unknown as Parameters<typeof enqueueTask>[1];
    execute.mockResolvedValue({ rows: [{ id: "t-new", created: true }] });
    await expect(enqueueTask(task, tx)).resolves.toEqual({ id: "t-new", created: true });
    expect(publish).not.toHaveBeenCalled();
  });
});
