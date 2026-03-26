import { eq, and, asc } from "drizzle-orm";
import { requireSession, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, messages } from "@/lib/db/schema";

function sanitizeFilename(name: string): string {
  return name.replace(/["\\\n\r]/g, "_");
}

export const GET = apiHandler(async (req, { params }) => {
  const { userId } = await requireSession();
  const { id } = await params;

  const [chat] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .limit(1);
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, id))
    .orderBy(asc(messages.createdAt))
    .limit(5000);

  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") || "json";
  const safeName = sanitizeFilename(chat.title || "chat");

  if (format === "markdown") {
    const lines: string[] = [`# ${chat.title || "Untitled Chat"}`, ""];
    for (const msg of rows) {
      const ts = msg.createdAt
        ? new Date(msg.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
        : "";
      const label = msg.role === "user" ? "You" : "Assistant";
      lines.push(`### ${label}${ts ? ` — ${ts}` : ""}`, "", msg.content, "");
    }
    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeName}.md"`,
      },
    });
  }

  return Response.json({
    chat: { id: chat.id, title: chat.title, model: chat.model, createdAt: chat.createdAt, updatedAt: chat.updatedAt },
    messages: rows.map((m) => ({ id: m.id, role: m.role, content: m.content, platform: m.platform, metadata: m.metadata, createdAt: m.createdAt })),
  }, {
    headers: { "Content-Disposition": `attachment; filename="${safeName}.json"` },
  });
});
