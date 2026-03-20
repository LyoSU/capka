import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL || "postgresql://anticlaw:anticlaw@localhost:5432/anticlaw";

export const db = drizzle(connectionString, { schema });
