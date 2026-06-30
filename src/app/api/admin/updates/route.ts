import { requireAdmin, apiHandler } from "@/lib/auth";
import { getUpdateStatus } from "@/lib/updates/check";

// Admin-only: running version vs the latest GitHub release. Best-effort and
// cached upstream, so this stays cheap to poll from the settings page/banner.
export const GET = apiHandler(async () => {
  await requireAdmin();
  return Response.json(await getUpdateStatus());
});
