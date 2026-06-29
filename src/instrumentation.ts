/**
 * Next.js calls register() once per server instance at startup. We start the
 * in-process durable task worker here, but only on the Node.js runtime (never
 * Edge), and never block server readiness on it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Audit the environment first and surface every misconfiguration as one loud
  // block — a malformed master key, a bad DATABASE_URL, a typo'd numeric knob.
  // Advisory only: we never crash here, because the setup page must still load.
  const { reportConfig } = await import("@/lib/config/check");
  reportConfig();

  // Bring the schema up to date so self-hosting needs no manual migrate step.
  // A failure here shouldn't prevent the server from booting (e.g. the setup
  // page should still load to surface the problem) — log loudly and continue.
  try {
    const { runMigrations } = await import("@/lib/db/migrate");
    await runMigrations();
  } catch (e) {
    console.error("[db] auto-migration failed (continuing without it):", e);
  }

  // Guard against a master key that no longer matches the data at rest (e.g. a
  // changed/lost CAPKA_MASTER_KEY). Establishes the check value on first boot.
  // Log loudly but don't crash — the setup/diagnostic page must still load.
  try {
    const { assertMasterKeyConsistent } = await import("@/lib/settings");
    await assertMasterKeyConsistent();
  } catch (e) {
    console.error("[security]", e instanceof Error ? e.message : e);
  }

  const { startWorker } = await import("@/lib/tasks/worker");
  await startWorker();

  // Start the Telegram bot in long-polling mode (no-op if no token configured).
  // Never block startup on it.
  try {
    const { startBot } = await import("@/lib/telegram/bot");
    await startBot();
  } catch (e) {
    console.error("[telegram] failed to start bot polling:", e);
  }
}
