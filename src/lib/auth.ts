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
    user: {
      additionalFields: {
        role: { type: "string", defaultValue: "user", input: false },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    plugins: [nextCookies()],
  });
  return _auth as ReturnType<typeof betterAuth>;
}

export type Role = "admin" | "user" | "viewer";

/** Require authenticated session — returns userId and role or throws 401 Response. */
export async function requireSession(): Promise<{
  userId: string;
  role: Role;
  session: Awaited<ReturnType<Awaited<ReturnType<typeof getAuth>>["api"]["getSession"]>>;
}> {
  const { headers } = await import("next/headers");
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw Response.json({ error: "Unauthorized" }, { status: 401 });
  const rawRole = (session.user as Record<string, unknown>).role;
  const role: Role = rawRole === "admin" || rawRole === "viewer" ? rawRole : "user";
  return { userId: session.user.id, role, session };
}

/** Require a minimum role — throws 403 if insufficient. */
export async function requireRole(...allowed: Role[]) {
  const ctx = await requireSession();
  if (!allowed.includes(ctx.role)) {
    throw Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return ctx;
}

/** Require admin role. */
export async function requireAdmin() {
  return requireRole("admin");
}
