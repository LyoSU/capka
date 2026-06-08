/**
 * Next.js calls register() once per server instance at startup. We start the
 * in-process durable task worker here, but only on the Node.js runtime (never
 * Edge), and never block server readiness on it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Bring the schema up to date so self-hosting needs no manual migrate step.
  // A failure here shouldn't prevent the server from booting (e.g. the setup
  // page should still load to surface the problem) — log loudly and continue.
  try {
    const { runMigrations } = await import("@/lib/db/migrate");
    await runMigrations();
  } catch (e) {
    console.error("[db] auto-migration failed (continuing without it):", e);
  }

  const { startWorker } = await import("@/lib/tasks/worker");
  await startWorker();
}
