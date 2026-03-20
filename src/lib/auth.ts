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

/** Require authenticated session — returns userId or throws 401 Response.
 *  Must only be called from server-side route handlers. */
export async function requireSession(): Promise<{ userId: string; session: Awaited<ReturnType<Awaited<ReturnType<typeof getAuth>>["api"]["getSession"]>> }> {
  const { headers } = await import("next/headers");
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw Response.json({ error: "Unauthorized" }, { status: 401 });
  return { userId: session.user.id, session };
}
