import { Client } from "pg";
import { DATABASE_URL } from "@/lib/db";
import { log } from "@/lib/log";

/**
 * Realtime fan-out over Postgres LISTEN/NOTIFY. Replaces the old in-memory
 * event bus so events survive across processes: a background worker can
 * publish while an SSE route in any instance receives. Truth never lives in
 * one process's memory.
 *
 * Channels are namespaced strings (e.g. "user:<id>", "task_enqueued") and
 * sanitized to safe Postgres identifiers. Payloads are JSON; NOTIFY caps at
 * 8000 bytes, so oversized payloads are replaced with a minimal "refresh"
 * marker and the client re-reads from the DB.
 */
type Cb = (data: unknown) => void;

const NOTIFY_LIMIT = 7500;

const RECONNECT_MAX_MS = 30_000;

class Realtime {
  private sub: Client | null = null;
  private pub: Client | null = null;
  private subConnecting: Promise<void> | null = null;
  private pubConnecting: Promise<Client> | null = null;
  private chans = new Map<string, Set<Cb>>();
  private reconnectDelay = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private buildSubClient(): Client {
    const client = new Client({ connectionString: DATABASE_URL });
    client.on("notification", (m) => {
      if (!m.channel || !m.payload) return;
      const cbs = this.chans.get(m.channel);
      if (!cbs) return;
      let data: unknown;
      try {
        data = JSON.parse(m.payload);
      } catch {
        return;
      }
      cbs.forEach((cb) => cb(data));
    });
    // Both `error` (reset/refused) and `end` (silent server-side close) drop the
    // LISTEN feed. Without handling `end`, every SSE stream and the worker's
    // task_enqueued channel goes quiet after a blip — the #1 "everything froze"
    // report. Re-establish with backoff and re-LISTEN all live channels.
    client.on("error", (err) => {
      log.error("LISTEN connection error, will reconnect", { err: String(err) });
      this.handleSubDrop(client);
    });
    client.on("end", () => {
      log.warn("LISTEN connection ended, will reconnect");
      this.handleSubDrop(client);
    });
    return client;
  }

  private handleSubDrop(dropped: Client): void {
    // Ignore drops from a stale client we've already replaced.
    if (this.sub && this.sub !== dropped) return;
    this.sub = null;
    // Nothing to keep alive if no one is listening.
    if (this.chans.size > 0) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.subConnecting) return;
    this.reconnectDelay = Math.min(this.reconnectDelay ? this.reconnectDelay * 2 : 1_000, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSub()
        .then(() => { this.reconnectDelay = 0; })
        .catch((err) => {
          log.error("LISTEN reconnect failed, retrying", { err: String(err) });
          this.scheduleReconnect();
        });
    }, this.reconnectDelay);
  }

  private async ensureSub(): Promise<void> {
    if (this.sub) return;
    if (this.subConnecting) return this.subConnecting;
    this.subConnecting = (async () => {
      const client = this.buildSubClient();
      await client.connect();
      this.sub = client;
      // (Re-)subscribe to every channel we still have listeners for.
      for (const ch of this.chans.keys()) await client.query(`LISTEN "${ch}"`);
    })();
    try {
      await this.subConnecting;
    } finally {
      this.subConnecting = null;
    }
  }

  async subscribe(channel: string, cb: Cb): Promise<() => void> {
    const ch = channelName(channel);
    if (!this.chans.has(ch)) this.chans.set(ch, new Set());
    this.chans.get(ch)!.add(cb);
    try {
      await this.ensureSub();
      // Quote the identifier: pg_notify() takes a case-SENSITIVE text channel,
      // but an unquoted `LISTEN ident` is folded to lowercase by Postgres. With a
      // mixed-case channel (user IDs contain uppercase) the two would never match
      // and no event would ever be delivered. Quoting preserves case on both sides.
      await this.sub!.query(`LISTEN "${ch}"`);
    } catch (e) {
      // Roll the registration back: the caller sees the failure and never gets
      // an unsubscribe, so a callback left behind here would be a dead closure
      // fanned out to on every future NOTIFY — forever. Reconnect storms during
      // a DB blip used to accumulate these.
      const set = this.chans.get(ch);
      set?.delete(cb);
      if (set && set.size === 0) this.chans.delete(ch);
      throw e;
    }
    return () => {
      const set = this.chans.get(ch);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) {
        this.chans.delete(ch);
        this.sub?.query(`UNLISTEN "${ch}"`).catch(() => {});
      }
    };
  }

  private async ensurePub(): Promise<Client> {
    if (this.pub) return this.pub;
    // Single-flight the connect: without it, two concurrent publishes each open
    // their own Client and the second clobbers `this.pub`, leaking the first
    // (its error/end guards key on `this.pub === client`, now false, so it's
    // never .end()ed). Concurrent callers await the same in-flight connect.
    if (this.pubConnecting) return this.pubConnecting;
    this.pubConnecting = (async () => {
      const client = new Client({ connectionString: DATABASE_URL });
      // Drop the handle on error/end so the next publish lazily reconnects.
      client.on("error", (err) => {
        log.error("NOTIFY connection error", { err: String(err) });
        if (this.pub === client) this.pub = null;
      });
      client.on("end", () => {
        if (this.pub === client) this.pub = null;
      });
      await client.connect();
      this.pub = client;
      return client;
    })();
    try {
      return await this.pubConnecting;
    } finally {
      this.pubConnecting = null;
    }
  }

  async publish(channel: string, data: unknown): Promise<void> {
    const pub = await this.ensurePub();
    let payload = JSON.stringify(data ?? {});
    if (Buffer.byteLength(payload) > NOTIFY_LIMIT) {
      // Too big for NOTIFY — send a marker so the client re-reads from the DB.
      const base = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      payload = JSON.stringify({
        type: base.type ?? "refresh",
        chatId: base.chatId,
        taskId: base.taskId,
        messageId: base.messageId,
        // Carry small routing scalars through the truncation so a dropped
        // tool-result body still tells the client WHICH call resolved (it backfills
        // the body from the DB). Without toolCallId/seq the client can't match the
        // result to its pending tool call and the step spins forever — exactly the
        // failure the runner's size pre-check tries (but can't fully) to avoid,
        // since it measures only the body, not this envelope.
        ...(base.toolCallId !== undefined ? { toolCallId: base.toolCallId } : {}),
        ...(base.seq !== undefined ? { seq: base.seq } : {}),
        ...(base.isError !== undefined ? { isError: base.isError } : {}),
        _truncated: true,
      });
    }
    await pub.query("SELECT pg_notify($1, $2)", [channelName(channel), payload]);
  }

  /** Ops counters for the worker's periodic health line. `pubQueue` reads pg's
   *  internal per-client query queue (concurrent publishes serialize there) —
   *  a persistently growing value means the NOTIFY connection is wedged and
   *  every queued publish is pinning its payload in memory. `_queryQueue` (not
   *  the public `queryQueue` getter) deliberately: the getter prints a
   *  deprecation notice on every read. */
  stats(): { channels: number; listeners: number; pubQueue: number } {
    let listeners = 0;
    for (const s of this.chans.values()) listeners += s.size;
    const q = (this.pub as unknown as { _queryQueue?: unknown[] } | null)?._queryQueue;
    return { channels: this.chans.size, listeners, pubQueue: Array.isArray(q) ? q.length : 0 };
  }
}

// Postgres LISTEN identifiers can't be parameterized, so sanitize to a safe,
// deterministic name.
function channelName(c: string): string {
  return "ch_" + c.replace(/[^a-zA-Z0-9_]/g, "_");
}

const g = globalThis as unknown as { __realtime?: Realtime };
export const realtime = g.__realtime ?? (g.__realtime = new Realtime());
