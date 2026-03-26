import { eq, asc } from "drizzle-orm";
import { requireSession, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, messages } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";

function sanitizeFilename(name: string): string {
  // ASCII-safe fallback for Content-Disposition header
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\\n\r]/g, "_");
  return ascii || "chat";
}

export const GET = apiHandler(async (req, { params }) => {
  const { userId } = await requireSession();
  const { id } = await params;

  const chat = await requireOwned(chats, id, userId, "Chat");

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, id))
    .orderBy(asc(messages.createdAt))
    .limit(5000);

  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") || "json";
  const title = (chat.title as string) || "chat";
  const safeName = sanitizeFilename(title);
  const disposition = (ext: string) =>
    `attachment; filename="${safeName}.${ext}"; filename*=UTF-8''${encodeURIComponent(title)}.${ext}`;

  if (format === "markdown") {
    const lines: string[] = [`# ${title}`, ""];
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
        "Content-Disposition": disposition("md"),
      },
    });
  }

  return Response.json({
    chat: { id: chat.id, title: chat.title, model: chat.model, createdAt: chat.createdAt, updatedAt: chat.updatedAt },
    messages: rows.map((m) => ({ id: m.id, role: m.role, content: m.content, platform: m.platform, metadata: m.metadata, createdAt: m.createdAt })),
  }, {
    headers: { "Content-Disposition": disposition("json") },
  });
});
