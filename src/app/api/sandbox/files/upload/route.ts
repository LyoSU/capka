import { requireRole, apiHandler } from "@/lib/auth";
import { uploadFile } from "@/lib/sandbox/client";
import { resolveWorkspaceTarget } from "@/lib/sandbox/target";
import { take } from "@/lib/rate-limit";

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const rl = take(`sandbox-upload:${userId}`);
  if (!rl.ok) return Response.json({ error: "Too many uploads — please slow down." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  const formData = await req.formData();
  const chatId = formData.get("chatId") as string | null;
  const projectId = formData.get("projectId") as string | null;
  const path = (formData.get("path") as string) || ".";
  const file = formData.get("file") as File;

  if (!file) return Response.json({ error: "Missing file" }, { status: 400 });

  const { sessionKey } = await resolveWorkspaceTarget({ userId, chatId, projectId });
  const result = await uploadFile(sessionKey, path, file, userId);
  return Response.json(result);
});
