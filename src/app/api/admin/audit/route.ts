import { apiHandler, requireAdmin } from "@/lib/auth";
import { listAudit } from "@/lib/governance/audit";

export const GET = apiHandler(async (req: Request) => {
  await requireAdmin();
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit")) || 100, 500);
  return Response.json({ entries: await listAudit(limit) });
});
