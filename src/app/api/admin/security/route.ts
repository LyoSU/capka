import { requireAdmin, apiHandler } from "@/lib/auth";
import { getMasterKeyStatus, removeStoredMasterKey } from "@/lib/settings";

/** Master-key security posture for the admin banner. The plaintext DB key is
 *  returned ONLY when it is the active source (so it can be promoted to env) and
 *  ONLY to an admin. */
export const GET = apiHandler(async () => {
  await requireAdmin();
  const { source, dbKeyPresent, dbKey } = await getMasterKeyStatus();
  return Response.json({ source, dbKeyPresent, key: dbKey });
});

/** Remove the leftover DB copy after the admin has moved the key to env. Refuses
 *  unless UNCLAW_MASTER_KEY is set, so an admin can never lock themselves out. */
export const DELETE = apiHandler(async () => {
  await requireAdmin();
  if (!process.env.UNCLAW_MASTER_KEY?.trim()) {
    return Response.json(
      { error: "Set UNCLAW_MASTER_KEY in the environment and restart before removing the database copy." },
      { status: 400 },
    );
  }
  await removeStoredMasterKey();
  return Response.json({ ok: true });
});
