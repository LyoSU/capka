import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://unClaw:unClaw@localhost:5432/unClaw";

export const db = drizzle(DATABASE_URL, { schema });
