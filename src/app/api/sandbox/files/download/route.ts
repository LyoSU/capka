import { requireSession } from "@/lib/auth";
import { execCommand, createSession } from "@/lib/sandbox/client";

export async function GET(req: Request) {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  const path = searchParams.get("path");

  if (!chatId || !path) return Response.json({ error: "Missing chatId or path" }, { status: 400 });

  try {
    await createSession(chatId, userId);
    const result = await execCommand(chatId, `cat '${path.replace(/'/g, "'\\''")}'`);

    if (result.exitCode !== 0) {
      return Response.json({ error: result.stderr || "File not found" }, { status: 404 });
    }

    const filename = path.split("/").pop() || "file";
    return new Response(result.stdout, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "_")}"`,
      },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
