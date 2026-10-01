import { describe, it, expect, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";

// The content-mutation routes must refuse a read-only viewer and a not-yet-approved
// account BEFORE any handler body runs — that gate is requireWriter. Keep apiHandler
// + the real error classes so a thrown ForbiddenError maps to 403; stub only the gate.
// (vi.hoisted because the mock factory is lifted above imports.)
const { requireWriter, requireSession, requireActive, approveManageForUser, answerAskForUser, answerElicitationForUser } = vi.hoisted(() => ({
  requireWriter: vi.fn(),
  requireSession: vi.fn(),
  // An ACTIVE viewer passes requireActive — so a route still gated on it lets them in.
  requireActive: vi.fn(async () => ({ userId: "u1", role: "viewer" as const, status: "active" as const })),
  approveManageForUser: vi.fn(async () => "applied"),
  answerAskForUser: vi.fn(async () => "applied"),
  answerElicitationForUser: vi.fn(async () => true),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireWriter, requireSession, requireActive };
});
vi.mock("@/lib/manage/authed", () => ({ approveManageForUser }));
vi.mock("@/lib/ask/authed", () => ({ answerAskForUser, answerElicitationForUser }));
// Reached only past the gate; make the skills lookup return nothing so a passing
// call lands on 404 (proving the gate let it through) rather than touching a DB.
vi.mock("@/lib/skills/service", () => ({
  listManagedSkills: () => Promise.resolve([]),
  getSkillMeta: () => Promise.resolve(null),
  deleteSkill: () => Promise.resolve(),
  setSkillEnabled: () => Promise.resolve(),
}));
vi.mock("@/lib/mcp/service", () => ({ getAccessibleServer: () => Promise.resolve(null) }));

import { PATCH as skillsPatch, DELETE as skillsDelete } from "@/app/api/skills/route";
import { PATCH as extPatch, DELETE as extDelete } from "@/app/api/extensions/route";
import { DELETE as oauthDelete } from "@/app/api/mcp/oauth/route";
import { POST as approvePost } from "@/app/api/manage/approve/route";
import { POST as answerPost } from "@/app/api/ask/answer/route";

const refuse = () => Promise.reject(new ForbiddenError("read-only"));
const asUser = () => Promise.resolve({ userId: "u1", role: "user" as const, status: "active" as const });

describe("content-mutation routes require a write-capable account", () => {
  it("a viewer / pending account is refused (403) on every content mutation", async () => {
    requireWriter.mockImplementation(refuse);

    expect((await skillsPatch(new Request("http://x", { method: "PATCH", body: JSON.stringify({ id: "s1", enabled: false }) }))).status).toBe(403);
    expect((await skillsDelete(new Request("http://x?id=s1", { method: "DELETE" }))).status).toBe(403);
    expect((await extPatch(new Request("http://x", { method: "PATCH", body: JSON.stringify({ installId: "i1", enabled: false }) }))).status).toBe(403);
    expect((await extDelete(new Request("http://x?installId=i1", { method: "DELETE" }))).status).toBe(403);
    expect((await oauthDelete(new Request("http://x?serverId=m1", { method: "DELETE" }))).status).toBe(403);
  });

  it("a writer (admin/user) passes the gate and reaches the handler", async () => {
    requireWriter.mockImplementation(asUser);
    // Skill not found for this user → 404, which means the gate let the request in.
    const res = await skillsPatch(new Request("http://x", { method: "PATCH", body: JSON.stringify({ id: "s1", enabled: false }) }));
    expect(res.status).toBe(404);
    expect(requireWriter).toHaveBeenCalled();
  });

  // Not a content mutation: a viewer cannot start a turn, so the suspended turns a
  // viewer owns are their automations' runs. Refusing the decision would leave each
  // one awaiting forever and the automation skipped as busy on every firing.
  it("a viewer can still approve a step or answer a question (gate is requireActive)", async () => {
    requireWriter.mockImplementation(refuse);
    const post = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });

    expect((await approvePost(post({ messageId: "m1", toolCallId: "t1", approved: false }))).status).toBe(200);
    expect(approveManageForUser).toHaveBeenCalledWith("u1", { messageId: "m1", toolCallId: "t1", approved: false });
    expect((await answerPost(post({ messageId: "m1", action: "skip" }))).status).toBe(200);
    expect(answerAskForUser).toHaveBeenCalled();
    expect(requireActive).toHaveBeenCalled();
  });
});
