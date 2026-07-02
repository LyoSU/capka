import { apiHandler } from "@/lib/auth";

// Public: the version stamped into this running image at build time
// (CAPKA_VERSION). Not sensitive — just what the About panel shows.
export const GET = apiHandler(async () => {
  return Response.json({ version: process.env.CAPKA_VERSION || "dev" });
});
