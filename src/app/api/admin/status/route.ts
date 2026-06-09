import { pool } from "@/lib/db";
import { requireAdmin, apiHandler } from "@/lib/auth";

/**
 * Deployment-wide AI health for the admin banner. With a shared provider key,
 * account-level failures (out of credit, bad key) hit every user identically and
 * persist until the admin acts — so the category of the MOST RECENT finished
 * assistant message is an accurate live signal: if someone topped up, the latest
 * message is a success and the banner clears on its own. Transient categories
 * (rate limits, network) are intentionally ignored so we don't nag.
 */
export const GET = apiHandler(async () => {
  await requireAdmin();

  const { rows } = await pool.query<{ category: string | null }>(
    `SELECT metadata->>'errorCategory' AS category
       FROM messages
      WHERE role = 'assistant'
        AND (metadata->>'status') IN ('completed', 'failed')
        AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC
      LIMIT 1`,
  );

  const category = rows[0]?.category ?? null;
  const blocking = category === "out_of_credits" || category === "invalid_key";
  return Response.json({ status: blocking ? category : "ok" });
});
