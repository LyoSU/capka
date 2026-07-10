import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { and, eq, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./db";
import * as schema from "./db/schema";
import { getMasterKey, getTelegramOidcConfig, getRegistrationMode, isSetupComplete } from "./settings";
import { getPublicUrl } from "./url";
import {
  decodeTelegramClaims,
  resolveRegistration,
  syntheticTelegramEmail,
  telegramDisplayName,
} from "./auth/telegram-oidc";
import { ZodError } from "zod";
import { AppError, isAppError, UnauthorizedError, ForbiddenError } from "./errors";

export const TELEGRAM_PROVIDER_ID = "telegram";
const TELEGRAM_DISCOVERY = "https://oauth.telegram.org/.well-known/openid-configuration";

/** The exact redirect URI an admin must register in BotFather → Web Login. */
export function telegramRedirectUri(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/auth/oauth2/callback/${TELEGRAM_PROVIDER_ID}`;
}

// Best-effort carry of the Telegram @username from the id_token (which better-
// auth's account row doesn't persist) into the telegram_links upsert that runs
// in the account.create.after hook, within the same sign-in request.
const pendingUsernames = new Map<number, string | null>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _auth: any = null;

/** Drop the cached instance so the next getAuth() rebuilds with fresh settings
 *  (called after an admin changes the Telegram login credentials/toggle). */
export function resetAuth(): void {
  _auth = null;
}

export async function getAuth() {
  if (_auth) return _auth as ReturnType<typeof betterAuth>;
  const secret = await getMasterKey();
  const publicUrl = process.env.PUBLIC_URL?.trim() || process.env.BETTER_AUTH_URL?.trim();
  const telegram = await getTelegramOidcConfig();
  _auth = betterAuth({
    secret,
    // Runtime, not build-time: an explicit PUBLIC_URL (operator override) wins;
    // otherwise leave it unset so better-auth infers the origin per-request from
    // the (proxy-aware) headers. No domain is ever baked into the image.
    baseURL: publicUrl || undefined,
    advanced: {
      // Tie the Secure-cookie prefix to the PUBLIC origin scheme, NOT NODE_ENV.
      // better-auth otherwise defaults secure cookies on in production even over
      // plain HTTP — so a localhost / HTTP-only deploy sets a `__Secure-` session
      // cookie the browser never sends back, and every authed request 401s
      // (login AND the setup model picker break). HTTPS public URL → secure;
      // localhost / HTTP-only / PUBLIC_URL unset → non-secure so auth works.
      // Behind a TLS-terminating proxy, set PUBLIC_URL=https://… (the Caddy and
      // Coolify paths do) to restore the Secure flag.
      useSecureCookies: (publicUrl ?? "").startsWith("https://"),
    },
    // CSRF check: trust whatever origin getPublicUrl resolves for this request
    // (PUBLIC_URL if set, else X-Forwarded-* / Host). Keeps the single domain in
    // one place instead of a second hardcoded constant.
    trustedOrigins: async (request?: Request) => [getPublicUrl({ headers: request?.headers })],
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
        // Lifecycle gate for the approval-based registration mode. input:false so
        // it can never be set from a client payload — only our hooks decide it.
        status: { type: "string", defaultValue: "active", input: false },
      },
    },
    // Account linking is enabled so an already-signed-in user can explicitly link
    // Telegram via /oauth2/link (an authenticated action, gated by the session).
    // Telegram is deliberately NOT a trustedProvider: trustedProviders would
    // auto-link a Telegram sign-in to any existing account whose email matches —
    // and our synthetic tg<id>@telegram.local addresses are predictable, so a
    // pre-registered email/password account could hijack a victim's Telegram
    // login. Auto-link-by-email has no legitimate use here (real users never own
    // an @telegram.local address), so we drop the root cause entirely. The
    // synthetic domain is also reserved against email sign-up (see the
    // /api/auth/[...all] gate) so it can't be squatted.
    account: {
      accountLinking: {
        enabled: true,
        updateUserInfoOnLink: true,
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Single registration policy for BOTH new Telegram identities (OAuth
          // callback) and email sign-ups: open → active, approval → pending,
          // closed → rejected (email is also blocked earlier in the [...all]
          // route; this is defense-in-depth). Registration never confers admin —
          // before setup completes sign-up is open (plain active users) so the
          // operator can bootstrap; admin is granted only by the SETUP_TOKEN-gated
          // /api/setup flow, never by being first to register.
          before: async (user, ctx) => {
            const isOAuth = !!ctx?.path?.includes("callback");
            const isEmailSignup = ctx?.path === "/sign-up/email";
            if (!isOAuth && !isEmailSignup) return;
            const decision = resolveRegistration({
              mode: await getRegistrationMode(),
              setupDone: await isSetupComplete(),
            });
            if (!decision.allow) {
              throw new APIError("FORBIDDEN", {
                code: "REGISTRATION_CLOSED",
                message: "Registration is disabled. Ask an administrator for access.",
              });
            }
            return { data: { ...user, role: decision.role, status: decision.status } };
          },
        },
      },
      account: {
        create: {
          // A Telegram account row appears both on first sign-in and when an
          // existing user links Telegram. Either way, mirror the binding into
          // telegram_links so the bot can DM this user with no /link CODE dance.
          after: async (account) => {
            if (account.providerId !== TELEGRAM_PROVIDER_ID) return;
            const telegramUserId = Number(account.accountId);
            if (!Number.isFinite(telegramUserId)) return;
            await upsertTelegramLink(account.userId, telegramUserId, pendingUsernames.get(telegramUserId) ?? null);
            pendingUsernames.delete(telegramUserId);
          },
        },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    plugins: [
      nextCookies(),
      ...(telegram.enabled
        ? [
            genericOAuth({
              config: [
                {
                  providerId: TELEGRAM_PROVIDER_ID,
                  clientId: telegram.clientId!,
                  clientSecret: telegram.clientSecret!,
                  discoveryUrl: TELEGRAM_DISCOVERY,
                  scopes: ["openid", "profile", "telegram:bot_access"],
                  pkce: true,
                  // Telegram has no userinfo endpoint — every claim is in the
                  // id_token. Decode it ourselves and map onto a better-auth user.
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  getUserInfo: async (tokens: any) => {
                    const claims = decodeTelegramClaims(tokens?.idToken);
                    if (!claims) return null;
                    pendingUsernames.set(claims.telegramUserId, claims.username);
                    return {
                      id: String(claims.telegramUserId),
                      name: telegramDisplayName(claims),
                      email: syntheticTelegramEmail(claims.telegramUserId),
                      emailVerified: false,
                      image: claims.picture ?? undefined,
                      createdAt: new Date(),
                      updatedAt: new Date(),
                    };
                  },
                },
              ],
            }),
          ]
        : []),
    ],
  });
  return _auth as ReturnType<typeof betterAuth>;
}

/** A drizzle transaction handle — the same query surface as `db`, so helpers can
 *  run either standalone or inside a caller's transaction. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Bind a Telegram numeric id to a platform user in telegram_links — the table
 * the bot delivery layer reads. Mirrors the bot's /link handler: re-point an
 * existing link instead of violating the unique constraint, and keep it
 * one-Telegram-per-user by dropping the user's other links. Runs on `db` by
 * default, or inside a caller's transaction when one is passed.
 */
async function upsertTelegramLink(userId: string, telegramUserId: number, username: string | null, exec: Executor = db) {
  const [existing] = await exec
    .select({ id: schema.telegramLinks.id })
    .from(schema.telegramLinks)
    .where(eq(schema.telegramLinks.telegramUserId, telegramUserId))
    .limit(1);
  if (existing) {
    await exec
      .update(schema.telegramLinks)
      .set({ userId, telegramUsername: username })
      .where(eq(schema.telegramLinks.id, existing.id));
  } else {
    await exec.insert(schema.telegramLinks).values({
      id: nanoid(),
      userId,
      telegramUserId,
      telegramUsername: username,
    });
  }
  await exec
    .delete(schema.telegramLinks)
    .where(and(eq(schema.telegramLinks.userId, userId), ne(schema.telegramLinks.telegramUserId, telegramUserId)));
}

/**
 * Fully disconnect a user's Telegram: the delivery link, any pending link code,
 * AND the better-auth `account` mapping that lets that Telegram id sign in as the
 * user. Deleting only the delivery link (the old behaviour) left the login
 * identity behind, so the previously-linked Telegram account could still
 * authenticate as the user — and switching Telegram A→B could strand A's mapping.
 * All three drop together in one transaction so an unlink can't half-apply.
 * A re-link (via the bot or web OIDC) re-provisions the mapping, so this is not
 * a lockout even for a Telegram-only account.
 */
export async function unlinkTelegramIdentity(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(schema.telegramLinks).where(eq(schema.telegramLinks.userId, userId));
    await tx.delete(schema.linkCodes).where(eq(schema.linkCodes.userId, userId));
    await tx
      .delete(schema.accounts)
      .where(and(eq(schema.accounts.providerId, TELEGRAM_PROVIDER_ID), eq(schema.accounts.userId, userId)));
  });
}

// Namespace for the per-Telegram-id advisory lock that serializes provisioning
// (arbitrary stable 32-bit key; the id is the lock's second arg).
const TG_PROVISION_LOCK = 0x74677576; // 'tguv'

/** The outcome of {@link provisionTelegramUser}: a resolved user (with its
 *  lifecycle status, which the caller still gates on) or a policy refusal. */
export type TelegramProvisionOutcome =
  | { userId: string; status: AccountStatus }
  | { refused: "closed" | "setup_incomplete" };

/**
 * Resolve — or, on first contact, CREATE — the platform user behind a Telegram
 * identity, applying the same registration policy the web OIDC sign-in uses
 * (`resolveRegistration`). Lets someone start using the bot without the web
 * round-trip, while never bypassing an admin's open/approval/closed choice.
 *
 * The whole resolve-or-create runs under a per-id advisory transaction lock so
 * two back-to-back Telegram updates from a brand-new user can't each create a
 * row (the `account` table has no unique on provider+accountId; the lock plus
 * the unique `user.email` / `telegram_links.telegram_user_id` backstops make a
 * duplicate impossible). The row it writes is byte-identical to the OIDC path's,
 * so a later "Sign in with Telegram" resolves to THIS user, not a duplicate.
 */
export async function provisionTelegramUser(
  telegramUserId: number,
  profile: { name: string | null; username: string | null },
): Promise<TelegramProvisionOutcome> {
  const accountId = String(telegramUserId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${TG_PROVISION_LOCK}, ${telegramUserId})`);

    // Identity is keyed on the account row (what a later OIDC sign-in also keys
    // on). If it exists the user is already known — reattach the (possibly
    // orphaned) link and report the existing status for the caller to gate.
    const [known] = await tx
      .select({ userId: schema.accounts.userId, status: schema.users.status })
      .from(schema.accounts)
      .innerJoin(schema.users, eq(schema.users.id, schema.accounts.userId))
      .where(and(eq(schema.accounts.providerId, TELEGRAM_PROVIDER_ID), eq(schema.accounts.accountId, accountId)))
      .limit(1);
    if (known) {
      await upsertTelegramLink(known.userId, telegramUserId, profile.username, tx);
      return { userId: known.userId, status: known.status as AccountStatus };
    }

    // A brand-new identity. Before first-run setup there's no admin and no
    // working provider, so there's nothing to answer with — refuse rather than
    // mint an orphan account (and never let a bot DM become the bootstrap admin).
    if (!(await isSetupComplete())) return { refused: "setup_incomplete" };
    const decision = resolveRegistration({ mode: await getRegistrationMode(), setupDone: true });
    if (!decision.allow) return { refused: "closed" };

    // Create the user. ON CONFLICT (email) DO NOTHING + re-select heals the rare
    // orphan case (a user row exists for this synthetic email but its account row
    // is missing) instead of throwing on the unique constraint.
    const email = syntheticTelegramEmail(telegramUserId);
    const newUserId = nanoid();
    await tx
      .insert(schema.users)
      .values({
        id: newUserId,
        name: telegramDisplayName({ telegramUserId, name: profile.name, username: profile.username, picture: null }),
        email,
        emailVerified: false,
        role: decision.role,
        status: decision.status,
      })
      .onConflictDoNothing({ target: schema.users.email });
    // Re-select by the unique email: this is the row we just inserted, or — when
    // the conflict fired — the pre-existing orphan. Report ITS status (not the
    // fresh decision), so healing an already-pending orphan stays pending.
    const [u] = await tx
      .select({ id: schema.users.id, status: schema.users.status })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    const userId = u!.id;

    // Tokenless account row — better-auth fills tokens on a later OIDC sign-in;
    // it only needs the provider+accountId→user mapping to avoid a duplicate user.
    await tx.insert(schema.accounts).values({ id: nanoid(), accountId, providerId: TELEGRAM_PROVIDER_ID, userId });
    await upsertTelegramLink(userId, telegramUserId, profile.username, tx);

    return { userId, status: u!.status as AccountStatus };
  });
}

export type Role = "admin" | "user" | "viewer";
export type AccountStatus = "active" | "pending" | "rejected";

/** Require authenticated session — throws UnauthorizedError. */
export async function requireSession(): Promise<{
  userId: string;
  role: Role;
  status: AccountStatus;
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
  // Fail-CLOSED: only an explicit "active" grants access. Anything else (pending,
  // rejected, or some future/manually-set value) is non-active and gated out — the
  // old `!== "pending" ? "active"` defaulted unknown statuses to active.
  const rawStatus = (session.user as Record<string, unknown>).status;
  const status: AccountStatus = rawStatus === "active" ? "active" : rawStatus === "pending" ? "pending" : "rejected";
  return { userId: session.user.id, role, status, session };
}

/** Require a minimum role — throws ForbiddenError if insufficient. Also gates out
 *  pending (awaiting-approval) accounts: they carry the "user" role but must have NO
 *  app access until approved. Centralizing the pending check here covers every
 *  role-checked route, not just the key-spending chat route. (Admins are never
 *  pending — the bootstrap user is active, approval mode assigns role "user".) */
export async function requireRole(...allowed: Role[]) {
  const ctx = await requireSession();
  if (!allowed.includes(ctx.role)) throw new ForbiddenError();
  if (ctx.status !== "active") throw inactiveError(ctx.status);
  return ctx;
}

/** Require an approved (active) account — gates pending/rejected users out of any
 *  feature that spends the shared key or exposes data. Admins are always active. */
export async function requireActive() {
  const ctx = await requireSession();
  if (ctx.status !== "active") throw inactiveError(ctx.status);
  return ctx;
}

/** The role-aware refusal for a non-active account. */
function inactiveError(status: AccountStatus): ForbiddenError {
  return new ForbiddenError(
    status === "pending"
      ? "Your account is awaiting administrator approval."
      : "Your account is not active.",
  );
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
