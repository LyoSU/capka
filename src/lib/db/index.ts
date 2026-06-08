import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://unClaw:unClaw@localhost:5432/unClaw";

// One shared pool for both Drizzle and the raw queries the durable queue needs
// (FOR UPDATE SKIP LOCKED, lease math) so we don't open redundant connections.
export const pool = new Pool({ connectionString: DATABASE_URL });

export const db = drizzle(pool, { schema });
