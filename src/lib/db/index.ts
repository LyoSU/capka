import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://unClaw:unClaw@localhost:5432/unClaw";

// One shared pool for both Drizzle and the raw queries the durable queue needs
// (FOR UPDATE SKIP LOCKED, lease math) so we don't open redundant connections.
// Bound the pool explicitly — API routes and the in-process worker share it, so
// an unbounded default could exhaust Postgres connections under load.
// Default sized for the worker: WORKER_MAX_CONCURRENCY (default 3) tasks each
// burst several parallel queries, and API routes draw from the same pool — 10
// starved them, so the floor is 20. Raise PG_POOL_MAX alongside concurrency.
export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 20,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });
