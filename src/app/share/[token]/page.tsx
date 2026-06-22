import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";

import { getAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";
import { loadActivePath } from "@/lib/chat/tree";
import { toUIMessages } from "@/lib/chat/presenter";
import { resolveShareAccess } from "@/lib/chat/sharing";
import { SharedChatView } from "@/components/chat/shared-chat-view";
import { ShareGate } from "@/components/chat/share-gate";

// A published conversation, viewable by its share token. This route lives
// OUTSIDE the (dashboard) group on purpose — no authed sidebar/chrome, and the
// visibility gate is enforced here server-side (never trust the client).
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const [chat] = await db
    .select({
      id: chats.id,
      title: chats.title,
      visibility: chats.visibility,
      activeLeafId: chats.activeLeafId,
    })
    .from(chats)
    .where(eq(chats.shareToken, token))
    .limit(1);

  // A logged-out visitor has no session — and getSession can throw on a bad
  // cookie, which on a public page must degrade to "anonymous", not a crash.
  const auth = await getAuth();
  const session = await auth.api
    .getSession({ headers: await headers() })
    .catch(() => null);
  const access = chat ? resolveShareAccess(chat.visibility, !!session) : "not-found";

  // Private / unknown / no-such-token all 404 identically — a private chat must
  // be indistinguishable from one that never existed.
  if (!chat || access === "not-found") notFound();
  // Shared only to members: show a sign-in gate rather than the conversation.
  if (access === "needs-auth") return <ShareGate />;

  const path = await loadActivePath(chat.id, chat.activeLeafId ?? null);
  const rows = path.map((p) => ({ ...p.node, siblingIndex: p.siblingIndex, siblingCount: p.siblingCount }));

  return (
    <SharedChatView
      title={chat.title}
      token={token}
      messages={toUIMessages(rows)}
      canClone={!!session}
    />
  );
}
