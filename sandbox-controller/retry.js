const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying on rejection with linear backoff up to `attempts` times.
 *  Re-throws the last error if the budget is exhausted. `sleep` is injectable so
 *  tests don't actually wait. Used at boot so a transient daemon blip retries
 *  (readiness stays false meanwhile) instead of crash-looping the process. */
export async function withRetry(fn, {
  attempts = 5, baseMs = 1000, label = "op", sleep = realSleep, log,
} = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      log?.("retry", { label, attempt: i, attempts, error: e.message }, "warn");
      // Linear backoff with full jitter: when several controllers boot against the
      // same daemon/DB at once, deterministic delays make them retry in lockstep
      // (thundering herd). Randomizing within the window spreads the load.
      if (i < attempts) await sleep(Math.round(baseMs * i * (0.5 + Math.random() * 0.5)));
    }
  }
  throw lastErr;
}
