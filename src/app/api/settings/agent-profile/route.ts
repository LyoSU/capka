import { requireAdmin, apiHandler } from "@/lib/auth";
import { getOrgAgentProfile, setOrgAgentProfile } from "@/lib/settings";

// The org-wide agent ceiling. Its own endpoint rather than a row in the generic
// key/value settings route: that route reads and writes single strings against a
// whitelist, while this is one validated object — squeezing it through as a JSON
// string would move validation to the client and let a malformed value clamp
// every agent on the instance. setOrgAgentProfile parses through the schema, so a
// stored ceiling is always a shape getOrgAgentProfile can read back.

export const GET = apiHandler(async () => {
  await requireAdmin();
  return Response.json(await getOrgAgentProfile());
});

export const PUT = apiHandler(async (req: Request) => {
  await requireAdmin();
  return Response.json(await setOrgAgentProfile(await req.json()));
});
