import { nanoid } from "nanoid";

import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";
import { uploadFile } from "@/lib/sandbox/client";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { intakeHash, shareText } from "@/lib/chat/intake";
import { inferMimeType, type FileRef } from "@/lib/constants";
import { take } from "@/lib/rate-limit";
import { log } from "@/lib/log";

// Relative Location: behind a proxy `req.url` names the internal host, and a
// browser resolves a relative redirect against the address it actually used.
const seeOther = (location: string) => new Response(null, { status: 303, headers: { Location: location } });

/** The manifest's `share_target`: the OS share sheet POSTs the shared files (and a
 *  title/text/url) here as a top-level navigation. They go into a NEW chat's
 *  workspace exactly as composer uploads do, and the person lands in that chat with
 *  the files staged and the text in the composer — nothing is sent for them.
 *
 *  Not under /share: the proxy treats every /share* path as public. */
export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await requireRole("admin", "user"));
  } catch {
    // The shared bytes cannot survive a sign-in round trip; landing on the login
    // page is the honest outcome, and sharing again afterwards works.
    return seeOther("/login");
  }

  const form = await req.formData().catch(() => null);
  if (!form) return seeOther("/chat");
  const text = shareText({
    title: form.get("title") as string | null,
    text: form.get("text") as string | null,
    url: form.get("url") as string | null,
  });
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0 && f.size <= 100 * 1024 * 1024 /* the composer's own per-file cap */);

  const chatId = nanoid();
  const refs: FileRef[] = [];
  if (files.length > 0 && take(`sandbox-upload:${userId}`).ok) {
    await db.insert(chats).values({ id: chatId, userId, title: "New Chat" });
    for (const file of files) {
      try {
        const { name } = await uploadFile(workspaceSessionKey({ id: chatId, projectId: null }), ".", file, userId);
        refs.push({ name: name || file.name, type: inferMimeType(file.name, file.type) });
      } catch (err) {
        // One file the sandbox refused should not cost the others; the person
        // sees what arrived and can attach the rest by hand.
        log.warn("intake upload failed", { chatId, err: String(err) });
      }
    }
  }
  return seeOther(`/chat/${chatId}${refs.length > 0 || text ? intakeHash(refs, text) : ""}`);
}
