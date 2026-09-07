import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { MAX_CHAT_SECRETS, MIN_SECRET_VALUE_CHARS } from "@/lib/chat/secrets";

/**
 * Storing a credential is a MUTATION, and it used to be gated by `requireSession` — which
 * admits an active `viewer`. Ownership alone let a downgraded account keep writing to a
 * chat it had created. Reading the names back is a read and stays open to a viewer.
 *
 * The other two gates here are about a value the rest of the system cannot honour: one
 * below the redactor's floor (stored under a promise nothing upstream kept), and one past
 * the controller's 32-entry `env` limit (the 33rd secret 400'd every command in the chat).
 */
const { requireSession, requireWriter, requireOwned, listSecretNames, setSecret, deleteSecret } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  requireWriter: vi.fn(),
  requireOwned: vi.fn(),
  listSecretNames: vi.fn(),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession, requireWriter };
});
vi.mock("@/lib/db/ownership", () => ({ requireOwned }));
// The validators and both limits are the real ones — they are what is under test. Only
// the three functions that touch the database are replaced.
vi.mock("@/lib/chat/secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat/secrets")>();
  return { ...actual, listSecretNames, setSecret, deleteSecret };
});

import { GET, POST, DELETE } from "@/app/api/chats/[id]/secrets/route";

const params = Promise.resolve({ id: "c1" });
const post = (body: unknown) =>
  POST(new Request("http://x/api/chats/c1/secrets", { method: "POST", body: JSON.stringify(body) }), { params });
const del = (body: unknown) =>
  DELETE(new Request("http://x/api/chats/c1/secrets", { method: "DELETE", body: JSON.stringify(body) }), { params });

const forbid = () => Promise.reject(new ForbiddenError("Read-only access."));

beforeEach(() => {
  requireSession.mockReset().mockResolvedValue({ userId: "u1", role: "viewer", status: "active" });
  requireWriter.mockReset().mockResolvedValue({ userId: "u1", role: "user", status: "active" });
  requireOwned.mockReset().mockResolvedValue({ id: "c1", userId: "u1" });
  listSecretNames.mockReset().mockResolvedValue([]);
  setSecret.mockReset().mockResolvedValue(undefined);
  deleteSecret.mockReset().mockResolvedValue(undefined);
});

describe("POST/DELETE /api/chats/[id]/secrets — write gate", () => {
  it("refuses a viewer before anything is stored", async () => {
    requireWriter.mockImplementation(forbid);
    const res = await post({ name: "stripe key", value: "sk-live-abcdef" });
    expect(res.status).toBe(403);
    expect(setSecret).not.toHaveBeenCalled();
    // Not the read gate: reaching for `requireSession` here is exactly the bug.
    expect(requireSession).not.toHaveBeenCalled();
  });

  it("refuses a viewer's delete before anything is removed", async () => {
    requireWriter.mockImplementation(forbid);
    const res = await del({ name: "stripe key" });
    expect(res.status).toBe(403);
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  it("still lets a viewer read the names", async () => {
    listSecretNames.mockResolvedValue([{ name: "STRIPE_KEY", createdAt: null }]);
    const res = await GET(new Request("http://x/api/chats/c1/secrets"), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secrets: [{ name: "STRIPE_KEY", createdAt: null }] });
  });
});

describe("POST /api/chats/[id]/secrets — a value the redactor would skip", () => {
  it("refuses a value below the floor, with a code of its own", async () => {
    const res = await post({ name: "key", value: "x".repeat(MIN_SECRET_VALUE_CHARS - 1) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALUE_TOO_SHORT" });
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("accepts a value at the floor", async () => {
    const res = await post({ name: "key", value: "x".repeat(MIN_SECRET_VALUE_CHARS) });
    expect(res.status).toBe(200);
    expect(setSecret).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/chats/[id]/secrets — the controller's env ceiling", () => {
  const full = Array.from({ length: MAX_CHAT_SECRETS }, (_, i) => ({ name: `K${i}`, createdAt: null }));

  it("refuses the one that would break every command in the chat", async () => {
    listSecretNames.mockResolvedValue(full);
    const res = await post({ name: "one more", value: "sk-live-abcdef" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "TOO_MANY" });
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("still lets an existing credential be rotated at the cap", async () => {
    // Overwriting a name adds no `env` entry, and being unable to replace a leaked
    // token because the list is full would be the worse failure.
    listSecretNames.mockResolvedValue(full);
    const res = await post({ name: "K0", value: "sk-live-rotated" });
    expect(res.status).toBe(200);
    expect(setSecret).toHaveBeenCalledTimes(1);
  });
});
