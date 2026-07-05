import { apiHandler, requireAdmin } from "@/lib/auth";
import { listAudit } from "@/lib/governance/audit";
import { AUDIT_ACTIONS } from "@/lib/governance/types";

// Coarse groupings an admin thinks in, each mapping to a set of action prefixes.
// Filtering server-side keeps offset/hasMore paging correct under a filter.
const CATEGORY_PREFIXES: Record<string, string[]> = {
  people: ["user."],
  security: ["master_key.", "auth_config.", "policy."],
  extensions: ["plugin.", "connector.", "skill.", "automation.", "folder."],
  settings: ["settings.", "billing."],
};

export const GET = apiHandler(async (req: Request) => {
  await requireAdmin();
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
  return Response.json({ entries: rows.slice(0, limit), hasMore });
});
