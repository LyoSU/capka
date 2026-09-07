import { and, eq, isNull, sql } from "drizzle-orm";
import { apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { automations, automationWebhookDeliveries, projects, users } from "@/lib/db/schema";
import { fireAutomation, type AutomationDisabledReason } from "@/lib/automations/runs";
import { getSetting } from "@/lib/settings";
import { log } from "@/lib/log";

/**
 * Fire an automation from outside the platform. NO SESSION: the URL is the whole
 * credential (no signature, no Authorization header), which is what makes it
 * usable from a spreadsheet, a form service or a cron box that cannot hold an
 * OAuth token — and what makes every rule below non-negotiable.
 *
 * Because the token is the credential:
 *  - EVERY refusal is the same `404 {"error":"Not found"}`. Unknown token, paused
 *    automation, suspended owner, deleted project, automations switched off
 *    platform-wide — one answer, so the route cannot be used to test whether a
 *    guessed URL exists or to watch an account's state from outside.
 *  - The body is UNTRUSTED, and is quoted as such into the run's user message
 *    (see quoteEvent / untrusted_ingress in lib/automations/runs.ts). Whoever
 *    holds the URL can put anything in it; nothing they write is an instruction.
 *  - Rate limiting is the daily run ceiling and nothing else. A second mechanism
 *    here would be a second thing to keep honest, and the cap is already the
 *    one the user configured, sees, and pays for. The one thing it must NOT be
 *    is optional: `max_runs_per_day` is nullable, and a leaked URL with no cap
 *    is unbounded paid ingress — so a webhook automation that has none falls
 *    back to `DEFAULT_WEBHOOK_RUNS_PER_DAY` (see lib/automations/runs.ts), which
 *    reports itself through the same `skipped, daily_limit` answer below.
 *
 * Every outcome that is not a refusal is a 202 with a `status` — accepted,
 * duplicate, or skipped with a reason — because a webhook sender needs to know
 * its call landed, and "skipped, daily_limit" is information, not an error.
 */

/** A body over this is refused outright. Only a prefix ever reaches the prompt
 *  (MAX_EVENT_CHARS in runs.ts); this bound is about not reading megabytes of
 *  someone else's payload into memory to then throw it away. */
const MAX_BODY_BYTES = 256 * 1024;

/** Idempotency keys are stored, so their length is bounded before anything is
 *  looked up — the check runs before the token lookup precisely so a rejected
 *  header cannot tell the caller whether the token was real. */
const MAX_IDEMPOTENCY_KEY = 200;

export const POST = apiHandler(async (req: Request, { params }: { params: Promise<{ token: string }> }) => {
  const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY) {
    return Response.json({ error: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY} characters.` }, { status: 400 });
  }

  // Content-Length first so an oversized body is refused before it is read, then
  // the actual bytes, because the header is the sender's claim and a chunked
  // request has no header at all.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = await req.text().catch(() => "");
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  const { token } = await params;
  if (!token) return notFound();
  const [row] = await db.select().from(automations).where(eq(automations.webhookToken, token));
  if (!row || !row.enabled) return notFound();

  // The admin's platform-wide switch, read HERE for the same reason the scheduler
  // reads it on every tick: turning automations off must actually stop them
  // spending the shared key. It is a temporary stop, so the row is left enabled
  // and simply not fired — flipping the switch back resumes it.
  if (((await getSetting("automations_enabled")) ?? "true") !== "true") return notFound();

  // The eligibility check the scheduler runs on every tick, repeated here because
  // a webhook row is NEVER ticked (next_run_at is NULL, so the claim never sees
  // it) — without this, an automation would outlive the account that made it and
  // the project it belongs to, and keep spending on the shared key. The reason is
  // written to the row exactly as the scheduler writes it, so the owner is told
  // WHY when they next look, instead of finding a silently dead endpoint.
  const [owner] = await db.select({ status: users.status }).from(users).where(eq(users.id, row.userId));
  let disabledReason: AutomationDisabledReason | null = null;
  if (owner?.status !== "active") {
    disabledReason = "owner_suspended";
  } else if (row.projectId) {
    const [project] = await db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, row.projectId), isNull(projects.deletedAt)));
    if (!project) disabledReason = "project_deleted";
  }
  if (disabledReason) {
    await db.update(automations)
      .set({ enabled: false, disabledReason, updatedAt: new Date() })
      .where(eq(automations.id, row.id));
    log.info("automation webhook refused — disabling", { automationId: row.id, reason: disabledReason });
    return notFound();
  }

  if (idempotencyKey) {
    // Prune BEFORE the insert, so the 24h window is real rather than aspirational:
    // a key last seen 25h ago must be able to fire again, and the only thing that
    // makes that true is that its row is gone by the time the insert runs. This
    // request owns that bound — nothing else deletes from this table.
    await db.delete(automationWebhookDeliveries)
      .where(sql`${automationWebhookDeliveries.createdAt} < now() - interval '24 hours'`);
    // Insert-first: "no row came back" IS the duplicate answer, so two concurrent
    // retries cannot both get past a read-then-write.
    const claimed = await db.insert(automationWebhookDeliveries)
      .values({ automationId: row.id, idempotencyKey })
      .onConflictDoNothing()
      .returning({ idempotencyKey: automationWebhookDeliveries.idempotencyKey });
    if (!claimed.length) return Response.json({ status: "duplicate" }, { status: 202 });
  }

  try {
    const { fired, chatId, reason, note } = await fireAutomation(row, { rawBody });
    // A skip is a real, reported outcome: the previous run is still working
    // ("busy"), the day's ceiling is reached ("daily_limit"), or the automation's
    // `run_when` condition did not hold for this event ("condition", with the
    // gate's one-line reason as `note` — a sender that pushes every event needs to
    // know its call landed and was judged, not merely that nothing happened). The
    // delivery key stays claimed either way: the call WAS processed, and a retry
    // that fired a second time would be exactly the duplicate the key prevents.
    if (!fired) {
      return Response.json({ status: "skipped", reason: reason ?? "busy", ...(note ? { note } : {}) }, { status: 202 });
    }
    return Response.json({ status: "accepted", chatId }, { status: 202 });
  } catch (e) {
    // The firing threw, so nothing was processed. Release the key so the sender's
    // retry is a first attempt rather than a duplicate of a run that never
    // happened — otherwise a transient DB blip drops the event permanently.
    if (idempotencyKey) {
      await db.delete(automationWebhookDeliveries)
        .where(and(
          eq(automationWebhookDeliveries.automationId, row.id),
          eq(automationWebhookDeliveries.idempotencyKey, idempotencyKey),
        ))
        .catch(() => {});
    }
    throw e;
  }
});
