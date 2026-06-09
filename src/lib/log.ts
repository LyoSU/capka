/**
 * Minimal structured logger. One JSON line per event (level, ts, msg + context),
 * so "who picked up which task and why it failed" is greppable instead of a
 * scatter of `[tag]` console strings. Intentionally dependency-free; swap the
 * sink for pino later without touching call sites.
 */
type Level = "debug" | "info" | "warn" | "error";
type Ctx = Record<string, unknown>;

function emit(level: Level, msg: string, ctx?: Ctx): void {
  const line = JSON.stringify({ level, ts: new Date().toISOString(), msg, ...(ctx ?? {}) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function make(base: Ctx) {
  return {
    debug: (msg: string, ctx?: Ctx) => emit("debug", msg, { ...base, ...ctx }),
    info: (msg: string, ctx?: Ctx) => emit("info", msg, { ...base, ...ctx }),
    warn: (msg: string, ctx?: Ctx) => emit("warn", msg, { ...base, ...ctx }),
    error: (msg: string, ctx?: Ctx) => emit("error", msg, { ...base, ...ctx }),
    /** Bind extra fixed context (e.g. taskId) on top of this logger's. */
    child: (extra: Ctx) => make({ ...base, ...extra }),
  };
}

export const log = make({});
export type Logger = ReturnType<typeof make>;
