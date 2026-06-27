import { requireSession } from "@/lib/auth";
import { isAppError, type AppError } from "@/lib/errors";
import { realtime } from "@/lib/realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let userId: string;
  try {
    const ctx = await requireSession();
    userId = ctx.userId;
  } catch (e) {
    if (isAppError(e)) return (e as AppError).toResponse();
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let torndown = false;

  // Single teardown, idempotent. Runs from cancel() (the normal client-disconnect
  // path), from req.signal abort (an independent trigger — some proxy/runtime
  // disconnects fire the request AbortSignal but never call cancel()), and from a
  // persistently-failing enqueue. Without all three, a dropped socket could leak
  // the heartbeat interval AND the Postgres LISTEN callback forever (every NOTIFY
  // then fans out to a growing set of dead closures).
  const teardown = () => {
    if (torndown) return;
    torndown = true;
    if (heartbeat) clearInterval(heartbeat);
    if (unsubscribe) unsubscribe();
  };
  req.signal.addEventListener("abort", teardown);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (data: string) => {
        if (torndown) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Controller closed without cancel() firing — clean up proactively.
          teardown();
        }
      };

      // Send initial connection event
      send(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

      // Subscribe to user events over Postgres LISTEN/NOTIFY
      unsubscribe = await realtime.subscribe(
        `user:${userId}`,
        (data: unknown) => {
          send(`data: ${JSON.stringify(data)}\n\n`);
        },
      );
      // If the request already aborted during the await above, tear down now —
      // the abort listener may have fired before `unsubscribe` was assigned.
      if (req.signal.aborted) teardown();

      // Heartbeat every 30s
      heartbeat = setInterval(() => {
        send(`: heartbeat\n\n`);
      }, 30_000);
    },
    cancel() {
      // Called when client disconnects
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defeat proxy buffering. Without this an upstream (nginx, and Caddy's
      // `encode`) holds the chunks and the whole reply lands at once — the
      // "I only see 'Processing' then all the text" symptom. `no-transform`
      // above tells Caddy not to compress; this covers nginx-style proxies.
      "X-Accel-Buffering": "no",
    },
  });
}
