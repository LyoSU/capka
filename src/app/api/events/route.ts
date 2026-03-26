import { requireSession } from "@/lib/auth";
import { isAppError, type AppError } from "@/lib/errors";
import { eventBus } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream closed
        }
      };

      // Send initial connection event
      send(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

      // Subscribe to user events
      unsubscribe = eventBus.subscribe(
        `user:${userId}`,
        (data: unknown) => {
          send(`data: ${JSON.stringify(data)}\n\n`);
        },
      );

      // Heartbeat every 30s
      heartbeat = setInterval(() => {
        send(`: heartbeat\n\n`);
      }, 30_000);
    },
    cancel() {
      // Called when client disconnects
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
