import { requireSession } from "@/lib/auth";
import { createSession, listFiles } from "@/lib/sandbox/client";

export async function GET(req: Request) {
  try {
    const { userId } = await requireSession();
    const { searchParams } = new URL(req.url);
    const chatId = searchParams.get("chatId");
    const path = searchParams.get("path") || ".";

    if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });

    await createSession(chatId, userId);
    const data = await listFiles(chatId, path);
    return Response.json(data);
  } catch (e) {
    if (e instanceof Response) return e;
    return Response.json({ entries: [], error: e instanceof Error ? e.message : "Failed" });
  }
}
