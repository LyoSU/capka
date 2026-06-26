/**
 * Wait for in-flight work to finish, bounded by a grace deadline.
 *
 * Used on shutdown (SIGTERM/SIGINT): the worker stops claiming new tasks and
 * calls this to let tasks already running finish cleanly, instead of being
 * killed mid-run and surfacing to the user as an interruption. Whatever is still
 * running when the grace elapses is left for the zombie reconciler on the next
 * instance (its lease expires → finalized as a friendly, retryable "interrupted"
 * — see reconcileZombies), so no work is ever silently dropped.
 *
 * Pure (clock + sleep injectable) so the wait/timeout behaviour is testable
 * without real signals or timers.
 */
export async function drainInFlight(
  getInFlight: () => number,
  graceMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
): Promise<{ drained: boolean; remaining: number }> {
  const deadline = now() + graceMs;
  const POLL_MS = 100;
  while (getInFlight() > 0 && now() < deadline) {
    await sleep(POLL_MS);
  }
  const remaining = getInFlight();
  return { drained: remaining === 0, remaining };
}
