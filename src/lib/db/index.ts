import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, defaults as pgDefaults, types as pgTypes } from "pg";
import * as schema from "./schema";

// Every timestamp column in the schema is `timestamp without time zone`, and the
// two clients that share this pool disagreed about what that means: Drizzle reads
// and writes them as UTC, while node-postgres used the PROCESS timezone — so a
// Date round-tripped through a raw query came back shifted by the host's offset.
// Under the UTC containers we ship, the offset is zero and nothing shows. On a box
// running TZ=Europe/Kyiv the scheduler fired automations three hours early, because
// its raw due-check (`next_run_at <= $1`) compared a Drizzle-written UTC row
// against a local-time parameter. Align node-postgres with Drizzle here, once, so
// no call site has to remember which encoding it is talking to.
pgDefaults.parseInputDatesAsUTC = true;
pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMP, (v) => new Date(`${v}Z`));

export const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://Capka:Capka@localhost:5432/Capka";

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
