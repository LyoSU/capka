/** Close the HTTP listener without letting a stuck keep-alive request block a
 *  controller rollout forever. Existing requests get a grace window; after it,
 *  Node's connection terminator is used when available. */
async function closeHttpServer(server, timeoutMs) {
  if (!server.listening) return { forced: false };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish({ forced: true });
    }, timeoutMs);
    timer.unref?.();

    try {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
          finish(undefined, error);
        } else {
          finish({ forced: false });
        }
      });
      server.closeIdleConnections?.();
    } catch (error) {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") finish({ forced: false });
      else finish(undefined, error);
    }
  });
}

/** Build an idempotent controller shutdown sequence. The injected callbacks keep
 *  the lifecycle independently testable without sending signals to the test
 *  runner or opening real sockets. */
export function createGracefulShutdown({
  server,
  store,
  pool,
  markNotReady,
  stopMaintenance,
  log,
  exit = (code) => process.exit(code),
  timeoutMs = 8_000,
}) {
  let inFlight;

  return function shutdown(signal) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let exitCode = 0;
      log("shutdown.start", { signal });

      try { markNotReady(); }
      catch (error) {
        exitCode = 1;
        log("shutdown.error", { signal, phase: "readiness", err: error.message }, "warn");
      }
      try { stopMaintenance(); }
      catch (error) {
        exitCode = 1;
        log("shutdown.error", { signal, phase: "maintenance", err: error.message }, "warn");
      }

      try {
        const { forced } = await closeHttpServer(server, timeoutMs);
        if (forced) log("shutdown.http_forced", { signal, timeoutMs }, "warn");
      } catch (error) {
        exitCode = 1;
        log("shutdown.error", { signal, phase: "http", err: error.message }, "warn");
      }

      try { await store.flush(); }
      catch (error) {
        exitCode = 1;
        log("shutdown.error", { signal, phase: "flush", err: error.message }, "warn");
      }
      try { await pool.end(); }
      catch (error) {
        exitCode = 1;
        log("shutdown.error", { signal, phase: "database", err: error.message }, "warn");
      }

      log("shutdown.done", { signal, exitCode });
      exit(exitCode);
    })();
    return inFlight;
  };
}

/** Keep handlers installed after the first signal: a repeated SIGTERM should join
 *  the same drain instead of restoring Node's default immediate termination. */
export function installShutdownHandlers(shutdown, proc = process) {
  const handlers = new Map();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const handler = () => { void shutdown(signal); };
    handlers.set(signal, handler);
    proc.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) proc.off(signal, handler);
  };
}
