import { requireSession } from "@/lib/auth";
import { execCommand, createSession } from "@/lib/sandbox/client";

export async function GET(req: Request) {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  const path = searchParams.get("path") || ".";

  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });

  try {
    // Ensure sandbox exists
    await createSession(chatId, userId);

    // List files with JSON-friendly output
    const result = await execCommand(
      chatId,
      `find '${path.replace(/'/g, "'\\''")}' -maxdepth 1 -not -name '.' -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null | sort -t$'\\t' -k1,1 -k4,4`,
    );

    if (result.exitCode !== 0) {
      return Response.json({ entries: [], error: result.stderr });
    }

    const entries = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [type, size, mtime, name] = line.split("\t");
        return {
          name,
          path: path === "." ? name : `${path}/${name}`,
          isDirectory: type === "d",
          size: parseInt(size) || 0,
          modifiedAt: mtime ? new Date(parseFloat(mtime) * 1000).toISOString() : null,
        };
      });

    return Response.json({ entries });
  } catch (e) {
    return Response.json({ entries: [], error: e instanceof Error ? e.message : "Failed" });
  }
}
