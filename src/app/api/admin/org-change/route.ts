import { eq } from "drizzle-orm";
import { apiHandler, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { buildRegistry } from "@/lib/manage/controls";
import { latestOrgChange } from "@/lib/manage/org-notice";
import { manageT, loc, locValue, keyOf } from "@/lib/manage/i18n";

/**
 * The most recent platform-wide setting change, for the admin banner — so a
 * colleague admin learns "X changed Sandbox network to Isolated" on their next
 * visit. Admin-only; never shows the actor their own change. The control title
 * and value are localized to THIS viewer's locale (the raw change is stored
 * locale-free), matching how the manage cards resolve strings.
 */
export const GET = apiHandler(async () => {
  const { userId } = await requireAdmin();

  const notice = await latestOrgChange();
  if (!notice || notice.actorId === userId) return Response.json({ notice: null });

  const c = buildRegistry().get(notice.controlId);
  if (!c) return Response.json({ notice: null });

  const [[actor], [viewer]] = await Promise.all([
    db.select({ name: users.name }).from(users).where(eq(users.id, notice.actorId)).limit(1),
    db.select({ locale: users.locale }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  const t = manageT(viewer?.locale ?? undefined);
  return Response.json({
    notice: {
      at: notice.at,
      actor: actor?.name ?? "An administrator",
      title: loc(t, `control.${keyOf(c.id)}.title`, c.title),
      value: locValue(t, c.id, notice.value, c.format ? c.format(notice.value) : notice.value),
    },
  });
});
