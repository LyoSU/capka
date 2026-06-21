/**
 * Pure helpers for the Telegram OIDC login flow. Kept free of DB/network so the
 * mapping and policy decisions are trivially unit-testable; the better-auth
 * wiring in `../auth.ts` calls into these.
 */

/** Registration policy an admin picks for Telegram sign-ups. */
export type RegistrationMode = "open" | "approval" | "closed";

/** Normalize a stored setting into a known mode (default: closed — fail safe). */
export function parseRegistrationMode(raw: string | null | undefined): RegistrationMode {
  return raw === "open" || raw === "approval" || raw === "closed" ? raw : "closed";
}

/** The subset of OIDC claims Telegram returns inside the id_token. */
export interface TelegramClaims {
  /** Telegram's numeric user id (the same id the Bot API uses as chat id for DMs). */
  telegramUserId: number;
  name: string | null;
  username: string | null;
  picture: string | null;
}

/**
 * Decode (NOT verify) the payload of a Telegram id_token. Signature validation
 * is better-auth's job during the OIDC exchange; here we only pull out the
 * claims we map onto a user. Telegram has no userinfo endpoint, so every claim
 * lives in the JWT. Returns null if the token is malformed or carries no id.
 */
export function decodeTelegramClaims(idToken: string | null | undefined): TelegramClaims | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  let payload: Record<string, unknown>;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    payload = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Telegram puts the numeric account id in `id`; `sub` is a separate long
  // string. The bot delivery layer keys on the numeric id, so that's the one.
  const rawId = payload.id ?? payload.sub;
  const telegramUserId =
    typeof rawId === "number" ? rawId : typeof rawId === "string" ? Number(rawId) : NaN;
  if (!Number.isFinite(telegramUserId) || telegramUserId === 0) return null;

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    telegramUserId,
    name: str(payload.name),
    username: str(payload.preferred_username) ?? str(payload.username),
    picture: str(payload.picture),
  };
}

/**
 * Reserved domain for the placeholder emails we mint for Telegram accounts.
 * It must NEVER be registrable via email/password sign-up: a synthetic address
 * is predictable (tg<id>@…), so letting someone claim one would let them
 * pre-seed an account a victim's Telegram login could later collide with.
 */
export const TELEGRAM_EMAIL_DOMAIN = "telegram.local";

/**
 * better-auth requires an email, but Telegram never supplies one (only a phone,
 * with consent). Synthesize a stable, unique, obviously-internal address from
 * the numeric id so the unique constraint holds and nothing leaks a fake domain
 * the user might mistake for real.
 */
export function syntheticTelegramEmail(telegramUserId: number): string {
  return `tg${telegramUserId}@${TELEGRAM_EMAIL_DOMAIN}`;
}

/** True for any address in the reserved Telegram placeholder domain. */
export function isReservedTelegramEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${TELEGRAM_EMAIL_DOMAIN}`);
}

/** A friendly display name when Telegram gave us neither name nor username. */
export function telegramDisplayName(claims: TelegramClaims): string {
  return claims.name ?? (claims.username ? `@${claims.username}` : `Telegram ${claims.telegramUserId}`);
}

export interface RegistrationDecision {
  /** Whether the account may be created at all. */
  allow: boolean;
  role: "admin" | "user";
  status: "active" | "pending";
}

/**
 * Decide what happens when a Telegram identity that maps to NO existing user
 * tries to sign in. The very first account on a fresh instance is always the
 * admin (bootstrap), regardless of mode — someone has to be able to finish
 * setup. After that, the admin-chosen mode governs:
 *   - open:     created active immediately
 *   - approval: created but parked as pending until an admin approves
 *   - closed:   rejected — only already-known accounts may sign in
 */
export function resolveRegistration(opts: {
  mode: RegistrationMode;
  isFirstUser: boolean;
}): RegistrationDecision {
  if (opts.isFirstUser) return { allow: true, role: "admin", status: "active" };
  switch (opts.mode) {
    case "open":
      return { allow: true, role: "user", status: "active" };
    case "approval":
      return { allow: true, role: "user", status: "pending" };
    case "closed":
      return { allow: false, role: "user", status: "active" };
  }
}
