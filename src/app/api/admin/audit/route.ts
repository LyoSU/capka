import { eq } from "drizzle-orm";
import { apiHandler, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { listAudit } from "@/lib/governance/audit";
import { AUDIT_ACTIONS } from "@/lib/governance/types";
import { buildRegistry } from "@/lib/manage/controls";
import { manageT, loc, keyOf } from "@/lib/manage/i18n";

// Coarse groupings an admin thinks in, each mapping to a set of action prefixes.
// Filtering server-side keeps offset/hasMore paging correct under a filter.
const CATEGORY_PREFIXES: Record<string, string[]> = {
  people: ["user."],
  security: ["master_key.", "auth_config.", "policy."],
  extensions: ["plugin.", "connector.", "skill.", "automation.", "folder."],
  settings: ["settings.", "billing."],
};

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const params = new URL(req.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 500);
  const offset = Math.max(Number(params.get("offset")) || 0, 0);

  const category = params.get("category");
  const prefixes = category ? CATEGORY_PREFIXES[category] : undefined;
  const actions = prefixes ? AUDIT_ACTIONS.filter((a) => prefixes.some((p) => a.startsWith(p))) : undefined;

  // Fetch one extra to tell the client whether a "load more" page exists,
  // without a second count query.
  const rows = await listAudit(limit + 1, offset, actions);
  const hasMore = rows.length > limit;

  // A `settings.update` stores the control's raw id ("user.locale") as its target.
  // Resolve that to the human title in THIS viewer's locale — the same way the
  // org-change banner does — so admins read "Interface language", not a dotted
  // handle. Done here, not at write time, so it localizes to the reader and also
  // fixes rows already in the log. A row that already carries a human `name`/
  // `label` (people/collection entries) is left untouched.
  const [viewer] = await db
    .select({ locale: users.locale }).from(users).where(eq(users.id, userId)).limit(1);
  const t = manageT(viewer?.locale ?? undefined);
  const reg = buildRegistry();
  const entries = rows.slice(0, limit).map((e) => {
    if (!e.targetKey || e.detail?.name || e.detail?.label) return e;
    const control = reg.get(e.targetKey);
    if (!control) return e;
    return { ...e, detail: { ...e.detail, label: loc(t, `control.${keyOf(e.targetKey)}.title`, control.title) } };
  });

  return Response.json({ entries, hasMore });
});
