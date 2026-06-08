import { Client } from "pg";
import { DATABASE_URL } from "@/lib/db";

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

class Realtime {
  private sub: Client | null = null;
  private pub: Client | null = null;
  private subConnecting: Promise<void> | null = null;
  private chans = new Map<string, Set<Cb>>();

  private async ensureSub(): Promise<void> {
    if (this.sub) return;
    if (this.subConnecting) return this.subConnecting;
    this.subConnecting = (async () => {
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
      client.on("error", (err) => {
        console.error("[realtime] LISTEN connection error, will reconnect:", err);
        this.sub = null;
      });
      await client.connect();
      this.sub = client;
      // (Re-)subscribe to every channel we still have listeners for.
      for (const ch of this.chans.keys()) await client.query(`LISTEN ${ch}`);
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
    await this.ensureSub();
    await this.sub!.query(`LISTEN ${ch}`);
    return () => {
      const set = this.chans.get(ch);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) {
        this.chans.delete(ch);
        this.sub?.query(`UNLISTEN ${ch}`).catch(() => {});
      }
    };
  }

  async publish(channel: string, data: unknown): Promise<void> {
    if (!this.pub) {
      this.pub = new Client({ connectionString: DATABASE_URL });
      this.pub.on("error", (err) => {
        console.error("[realtime] NOTIFY connection error:", err);
        this.pub = null;
      });
      await this.pub.connect();
    }
    let payload = JSON.stringify(data ?? {});
    if (Buffer.byteLength(payload) > NOTIFY_LIMIT) {
      // Too big for NOTIFY — send a marker so the client re-reads from the DB.
      const base = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      payload = JSON.stringify({
        type: base.type ?? "refresh",
        chatId: base.chatId,
        taskId: base.taskId,
        messageId: base.messageId,
        _truncated: true,
      });
    }
    await this.pub.query("SELECT pg_notify($1, $2)", [channelName(channel), payload]);
  }
}

// Postgres LISTEN identifiers can't be parameterized, so sanitize to a safe,
// deterministic name.
function channelName(c: string): string {
  return "ch_" + c.replace(/[^a-zA-Z0-9_]/g, "_");
}

const g = globalThis as unknown as { __realtime?: Realtime };
export const realtime = g.__realtime ?? (g.__realtime = new Realtime());
