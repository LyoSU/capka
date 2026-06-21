/** Durable session state in Postgres, replacing the in-memory Map so the
 *  controller survives restarts (no lost networkMode) and reconciles against the
 *  backend on boot. The hot path (exec) only calls touch(), which updates an
 *  in-process cache; a periodic flush() persists lastActivity — so we don't write
 *  a row on every exec. */
export class PostgresSessionStore {
  constructor({ pool }) {
    this.pool = pool;
    this._activity = new Map(); // sessionId -> lastActivity (not yet flushed)
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sandbox_sessions (
        session_id    text PRIMARY KEY,
        user_id       text   NOT NULL,
        handle        text   NOT NULL,
        network_mode  text   NOT NULL,
        last_activity bigint NOT NULL,
        created_at    bigint NOT NULL
      )
    `);
  }

  #map(row) {
    if (!row) return null;
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      handle: row.handle,
      networkMode: row.network_mode,
      lastActivity: Number(row.last_activity),
      createdAt: Number(row.created_at),
    };
  }

  async upsert(rec) {
    await this.pool.query(
      `INSERT INTO sandbox_sessions (session_id, user_id, handle, network_mode, last_activity, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_id) DO UPDATE SET
         user_id = EXCLUDED.user_id, handle = EXCLUDED.handle,
         network_mode = EXCLUDED.network_mode, last_activity = EXCLUDED.last_activity`,
      [rec.sessionId, rec.userId, rec.handle, rec.networkMode, rec.lastActivity, rec.createdAt],
    );
  }

  async get(sessionId) {
    const { rows } = await this.pool.query("SELECT * FROM sandbox_sessions WHERE session_id = $1", [sessionId]);
    return this.#map(rows[0]);
  }

  async delete(sessionId) {
    this._activity.delete(sessionId);
    await this.pool.query("DELETE FROM sandbox_sessions WHERE session_id = $1", [sessionId]);
  }

  async listByUser(userId) {
    const { rows } = await this.pool.query("SELECT * FROM sandbox_sessions WHERE user_id = $1", [userId]);
    return rows.map((r) => this.#map(r));
  }

  async all() {
    const { rows } = await this.pool.query("SELECT * FROM sandbox_sessions");
    return rows.map((r) => this.#map(r));
  }

  /** Record activity in-process; persisted later by flush(). */
  touch(sessionId, ts = Date.now()) {
    this._activity.set(sessionId, ts);
  }

  /** Persist cached lastActivity values, then clear the cache. */
  async flush() {
    if (this._activity.size === 0) return;
    const entries = [...this._activity.entries()];
    this._activity.clear();
    for (const [sessionId, ts] of entries) {
      await this.pool.query("UPDATE sandbox_sessions SET last_activity = $2 WHERE session_id = $1", [sessionId, ts]);
    }
  }
}
