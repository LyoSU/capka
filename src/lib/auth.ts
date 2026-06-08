import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "./db";
import * as schema from "./db/schema";
import { getMasterKey } from "./settings";
import { ZodError } from "zod";
import { AppError, isAppError, UnauthorizedError, ForbiddenError } from "./errors";

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

/** Require authenticated session — throws UnauthorizedError. */
export async function requireSession(): Promise<{
  userId: string;
  role: Role;
  session: Awaited<ReturnType<Awaited<ReturnType<typeof getAuth>>["api"]["getSession"]>>;
}> {
  const { headers } = await import("next/headers");
  const auth = await getAuth();
  let session;
  try {
    session = await auth.api.getSession({ headers: await headers() });
  } catch (e) {
    console.error("[auth] getSession threw:", e);
    throw new UnauthorizedError();
  }
  if (!session) throw new UnauthorizedError();
  const rawRole = (session.user as Record<string, unknown>).role;
  const role: Role = rawRole === "admin" || rawRole === "viewer" ? rawRole : "user";
  return { userId: session.user.id, role, session };
}

/** Require a minimum role — throws ForbiddenError if insufficient. */
export async function requireRole(...allowed: Role[]) {
  const ctx = await requireSession();
  if (!allowed.includes(ctx.role)) throw new ForbiddenError();
  return ctx;
}

/** Require admin role. */
export async function requireAdmin() {
  return requireRole("admin");
}

/** Wrap a route handler — catches AppError → safe response, unknown errors → generic 500. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apiHandler<T extends (...args: any[]) => Promise<Response>>(handler: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await handler(...args);
    } catch (e) {
      if (e instanceof ZodError) {
        return Response.json({ error: e.issues[0]?.message || "Invalid request" }, { status: 400 });
      }
      if (isAppError(e)) return (e as AppError).toResponse();
      const req = args[0] as Request;
      console.error(`[api] ${req.method} ${new URL(req.url).pathname}:`, e);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }) as T;
}
