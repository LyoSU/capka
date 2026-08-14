import { apiHandler, requireActive } from "@/lib/auth";
/**
 * GONE ON PURPOSE — a first install now goes through the review gate.
 *
 * This route wrote skills, connectors and executable plugin files with no `reviewHash` at
 * all, so the consent gate was bypassable simply by calling it. Kept as an explicit refusal,
 * rather than deleted, so an old client is told where to go instead of retrying a 405.
 *
 * The gate's own route enforces everything this one did — `requireWriter`, the
 * `membersCanInstallPlugins` switch, the "already installed for everyone" refusal — plus the
 * review a person has to have seen.
 */
export const POST = apiHandler(async () => {
  await requireActive();
  return Response.json(
    { error: "Installs now go through the install review. Use GET /api/extensions/review, then POST it back with the reviewHash." },
    { status: 410 },
  );
});
