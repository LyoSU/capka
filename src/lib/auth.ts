import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "./db";
import * as schema from "./db/schema";
import { getMasterKey } from "./settings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _auth: any = null;

export async function getAuth() {
  if (_auth) return _auth as ReturnType<typeof betterAuth>;
  const secret = await getMasterKey();
  _auth = betterAuth({
    secret,
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: { enabled: true },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    plugins: [nextCookies()],
  });
  return _auth as ReturnType<typeof betterAuth>;
}
