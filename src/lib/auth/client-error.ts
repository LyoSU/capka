/**
 * better-auth's client returns the server's raw APIError body as `error`
 * (`{ code, message, status, statusText }` — see @better-auth/core's
 * BASE_ERROR_CODES). `message` is always English and provider-shaped, so it
 * must never reach a non-technical, Ukrainian-first user directly. This maps
 * the small set of codes our auth flows can actually hit to a translation key
 * under the `auth.errors` namespace; unknown/missing codes fall through to
 * the caller's own generic fallback instead of leaking raw text.
 */
const CODE_TO_KEY: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "invalidCredentials",
  INVALID_PASSWORD: "invalidCredentials",
  USER_NOT_FOUND: "invalidCredentials",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "invalidCredentials",
  USER_ALREADY_EXISTS: "userExists",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "userExists",
  PASSWORD_TOO_SHORT: "passwordTooShort",
  PASSWORD_TOO_LONG: "passwordTooLong",
  INVALID_EMAIL: "invalidEmail",
  EMAIL_NOT_VERIFIED: "emailNotVerified",
};

/** Returns an `auth.errors.<key>` translation key, or undefined if the code is unmapped/absent. */
export function authErrorKey(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? CODE_TO_KEY[code] : undefined;
}
