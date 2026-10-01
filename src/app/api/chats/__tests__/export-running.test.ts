import { describe, it, expect, vi } from "vitest";

/**
 * A reply still streaming keeps its text only in `metadata.parts`: mid-stream snapshots
 * no longer write `messages.content` (runner.ts saveSnapshot), so its column holds ""
 * — or, on an approval continuation, just the first half. An export taken at that
 * moment must read the row the way a fork or a retitle does, not the bare column.
 */
const rows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireActive: vi.fn(async () => ({ userId: "u1" })),
}));
vi.mock("@/lib/db/ownership", () => ({
  requireOwned: vi.fn(async () => ({ id: "c1", title: "Plan", model: null, createdAt: null, updatedAt: null })),
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows.value }) }) }) }) },
}));

import { GET } from "@/app/api/chats/[id]/export/route";

const at = new Date("2026-09-30T10:00:00Z");
rows.value = [
  { id: "m1", role: "user", content: "Draft the memo", platform: "web", metadata: null, createdAt: at },
  {
    id: "m2", role: "assistant", content: "First half.", platform: "web", createdAt: at,
    metadata: { status: "running", parts: [{ type: "text", text: "First half." }, { type: "text", text: "Second half." }] },
  },
];

const call = (format: string) =>
  GET(new Request(`http://x/api/chats/c1/export?format=${format}`), { params: Promise.resolve({ id: "c1" }) });

describe("chat export of a reply still streaming", () => {
  it("writes the streamed text into the Markdown", async () => {
    const md = await (await call("markdown")).text();
    expect(md).toContain("Draft the memo");
    expect(md).toContain("First half.\n\nSecond half.");
  });

  it("writes the streamed text into the JSON content field", async () => {
    const body = await (await call("json")).json();
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual(["Draft the memo", "First half.\n\nSecond half."]);
  });
});
