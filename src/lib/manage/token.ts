import { createHmac, timingSafeEqual } from "node:crypto";

/** A short-lived, single-purpose token that binds a pending management action to
 *  the exact user + control + arguments it was issued for. It is HMAC-signed with
 *  the master key and carries its own expiry, so it needs no server-side storage
 *  (survives a restart, works across instances) while still preventing an agent
 *  from applying a *different* change than the one the user confirmed. */
export type TokenPayload =
  | { purpose: "confirm"; controlId: string; argsHash: string; userId: string }
  | { purpose: "undo"; controlId: string; prev: string; userId: string };

const DEFAULT_TTL_MS = 10 * 60 * 1000;

type SignOpts = { ttlMs?: number; now?: number };

/** Stable hash of an action's arguments — key order must not matter, so the same
 *  logical change always produces the same confirm token binding. */
export function hashArgs(args: unknown): string {
  // Full 256-bit digest, not a 64-bit prefix: the HMAC "key" here is a public
  // constant (it's a plain content hash, not a secret), so a truncated hash would
  // be collision-searchable offline — letting a token bound to one set of args be
  // reused for a colliding set. Full width closes that for free.
  return createHmac("sha256", "args").update(canonical(args)).digest("hex");
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signToken(payload: TokenPayload, secret: string, opts: SignOpts = {}): string {
  const now = opts.now ?? Date.now();
  const exp = now + (opts.ttlMs ?? DEFAULT_TTL_MS);
  const body = b64url(JSON.stringify({ ...payload, exp }));
  return `${body}.${sign(body, secret)}`;
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyToken(token: string, secret: string, now = Date.now()): VerifyResult {
  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(body, secret);
  // Constant-time compare; unequal lengths can't be equal and would throw.
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { ok: false, reason: "bad_signature" };
  }

  let decoded: TokenPayload & { exp: number };
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof decoded !== "object" || decoded === null) return { ok: false, reason: "malformed" };
  if (typeof decoded.exp !== "number") return { ok: false, reason: "malformed" };
  if (now >= decoded.exp) return { ok: false, reason: "expired" };

  const payload: Record<string, unknown> = { ...decoded };
  delete payload.exp;
  return { ok: true, payload: payload as TokenPayload };
}
