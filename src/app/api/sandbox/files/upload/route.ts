import { requireSession } from "@/lib/auth";
import { execCommand, createSession } from "@/lib/sandbox/client";

const CONTROLLER_URL = process.env.SANDBOX_CONTROLLER_URL || "http://sandbox-controller:3001";
const CONTROLLER_SECRET = process.env.CONTROLLER_SECRET || "changeme";

export async function POST(req: Request) {
  const { userId } = await requireSession();
  const formData = await req.formData();
  const chatId = formData.get("chatId") as string;
  const path = (formData.get("path") as string) || ".";
  const file = formData.get("file") as File;

  if (!chatId || !file) return Response.json({ error: "Missing chatId or file" }, { status: 400 });

  try {
    await createSession(chatId, userId);

    const safeName = file.name.replace(/['"\\]/g, "_");
    const targetPath = path === "." ? safeName : `${path}/${safeName}`;

    // Create parent dir
    await execCommand(chatId, `mkdir -p '${path.replace(/'/g, "'\\''")}'`);

    // Upload via controller's upload endpoint (streams file, no shell arg limit)
    const uploadForm = new FormData();
    uploadForm.append("file", file);
    uploadForm.append("path", targetPath);

    const res = await fetch(`${CONTROLLER_URL}/sessions/${chatId}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CONTROLLER_SECRET}` },
      body: uploadForm,
    });

    if (!res.ok) {
      // Fallback: small files via base64 chunks
      const bytes = await file.arrayBuffer();
      const base64 = Buffer.from(bytes).toString("base64");

      // Write in chunks to avoid argument length limits
      const chunkSize = 60000;
      const safePath = targetPath.replace(/'/g, "'\\''");
      await execCommand(chatId, `> '${safePath}'`); // create/truncate

      for (let i = 0; i < base64.length; i += chunkSize) {
        const chunk = base64.slice(i, i + chunkSize);
        await execCommand(chatId, `printf '%s' '${chunk}' >> /tmp/_upload.b64`);
      }
      const result = await execCommand(chatId, `base64 -d /tmp/_upload.b64 > '${safePath}' && rm /tmp/_upload.b64`, 60000);

      if (result.exitCode !== 0) {
        return Response.json({ error: result.stderr || "Upload failed" }, { status: 500 });
      }
    }

    return Response.json({ ok: true, path: targetPath, name: file.name });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
