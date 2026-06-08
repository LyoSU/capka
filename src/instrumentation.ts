/**
 * Next.js calls register() once per server instance at startup. We start the
 * in-process durable task worker here, but only on the Node.js runtime (never
 * Edge), and never block server readiness on it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWorker } = await import("@/lib/tasks/worker");
  await startWorker();
}
