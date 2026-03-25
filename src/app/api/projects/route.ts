import { eq, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession, requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";

export async function GET() {
  const { userId } = await requireSession();
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt));

  return Response.json(rows);
}

export async function POST(req: Request) {
  const { userId } = await requireRole("admin", "user");
  const body = await req.json();
  const { name, description, systemPrompt, defaultModel, sandboxNetwork } = body;

  if (!name?.trim()) {
    return Response.json({ error: "Name is required" }, { status: 400 });
  }

  const id = nanoid();
  const [project] = await db
    .insert(projects)
    .values({
      id,
      userId,
      name: name.trim(),
      description: description?.trim() || null,
      systemPrompt: systemPrompt?.trim() || null,
      defaultModel: defaultModel?.trim() || null,
      sandboxNetwork: sandboxNetwork === "bridge" ? "bridge" : "none",
    })
    .returning();

  return Response.json(project, { status: 201 });
}
