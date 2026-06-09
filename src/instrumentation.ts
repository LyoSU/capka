/**
 * Next.js calls register() once per server instance at startup. We start the
 * in-process durable task worker here, but only on the Node.js runtime (never
 * Edge), and never block server readiness on it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Validate the master key format early — a malformed UNCLAW_MASTER_KEY would
  // silently fail to decrypt every stored provider key. Don't crash (the setup
  // page must still load), but make the misconfiguration impossible to miss.
  const envKey = process.env.UNCLAW_MASTER_KEY?.trim();
  if (envKey) {
    const { isValidMasterKey } = await import("@/lib/crypto");
    if (!isValidMasterKey(envKey)) {
      console.error(
        "[security] UNCLAW_MASTER_KEY is set but malformed — it must be 64 hex characters " +
        "(32 bytes). Generate one with: openssl rand -hex 32. Encryption/decryption will fail until fixed.",
      );
    }
  }

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

  // Start the Telegram bot in long-polling mode (no-op if no token configured).
  // Never block startup on it.
  try {
    const { startBot } = await import("@/lib/telegram/bot");
    await startBot();
  } catch (e) {
    console.error("[telegram] failed to start bot polling:", e);
  }
}
