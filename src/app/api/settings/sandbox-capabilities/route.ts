import { requireAdmin, apiHandler } from "@/lib/auth";
import { getSandboxAllowNetwork } from "@/lib/sandbox/client";

// Runtime capability of the sandbox controller, not a DB setting: tells the
// admin UI whether the deployment-level kill-switch (SANDBOX_ALLOW_NETWORK)
// would actually honor an "Internet access" toggle. null = controller
// unreachable (unknown), so the UI leaves the toggle as-is rather than lying.
export const GET = apiHandler(async () => {
  await requireAdmin();
  return Response.json({ allowNetwork: await getSandboxAllowNetwork() });
});
