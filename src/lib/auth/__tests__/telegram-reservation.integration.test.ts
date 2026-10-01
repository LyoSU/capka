import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { pool } from "@/lib/db";
import { getAuth, resetAuth } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";
import { POST } from "@/app/api/auth/[...all]/route";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run telegram-reservation.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

// The synthetic tg<id>@telegram.local addresses belong to Telegram sign-in alone. These
// drive real requests through better-auth's handler (and the [...all] route in front of
// it), the way a browser or curl would, rather than calling the hook by hand.

const BASE = "http://localhost:3000";
const TG_ID = 990_000_101;
const TG_EMAIL = `tg${TG_ID}@telegram.local`;
const CONTROL_EMAIL = "reservation-control@example.com";
const KEYS = ["registration_mode", "setup_complete", "email_signup_enabled", "telegram_login_enabled", "telegram_oidc_client_id", "telegram_oidc_client_secret"];

async function userCount(email: string) {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "user" WHERE email = $1`, [email]);
  return Number(rows[0].n);
}

async function cleanup() {
  await pool.query(`DELETE FROM "user" WHERE email = ANY($1)`, [[TG_EMAIL, CONTROL_EMAIL]]);
  await pool.query(`DELETE FROM telegram_links WHERE telegram_user_id = $1`, [TG_ID]);
}

/** A form-encoded sign-up with no Origin, no Sec-Fetch headers and no cookie. */
function formSignUp(email: string) {
  return new Request(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: "correct-horse-battery", name: "Mallory" }).toString(),
  });
}

run("@telegram.local reservation", () => {
  const saved = new Map<string, string | null>();

  beforeAll(async () => {
    for (const k of KEYS) saved.set(k, await getSetting(k));
    vi.stubEnv("PUBLIC_URL", BASE);
    await setSetting("setup_complete", "true");
    await setSetting("registration_mode", "open");
    await setSetting("email_signup_enabled", "true");
    await setSetting("telegram_login_enabled", "true");
    await setSetting("telegram_oidc_client_id", "123456");
    await setSetting("telegram_oidc_client_secret", "test-secret");
    resetAuth();
  });
  afterAll(async () => {
    await cleanup();
    for (const [k, v] of saved) {
      if (v === null) await pool.query(`DELETE FROM settings WHERE key = $1`, [k]);
      else await setSetting(k, v);
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetAuth();
  });
  beforeEach(cleanup);

  it("a form-encoded sign-up reaches user creation (control)", async () => {
    const auth = await getAuth();
    const res = await auth.handler(formSignUp(CONTROL_EMAIL));
    expect(res.status).toBe(200);
    expect(await userCount(CONTROL_EMAIL)).toBe(1);
  });

  it("better-auth itself refuses a form-encoded sign-up for a synthetic address", async () => {
    const auth = await getAuth();
    const res = await auth.handler(formSignUp(TG_EMAIL));
    expect(res.status).toBe(400);
    expect(await userCount(TG_EMAIL)).toBe(0);
  });

  it("better-auth itself refuses a JSON sign-up for a synthetic address, whatever the case", async () => {
    const auth = await getAuth();
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: TG_EMAIL.toUpperCase(), password: "correct-horse-battery", name: "Mallory" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await userCount(TG_EMAIL)).toBe(0);
  });

  it("the [...all] route refuses a form-encoded synthetic sign-up up front", async () => {
    const res = await POST(formSignUp(TG_EMAIL));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "This email address is not allowed" });
    expect(await userCount(TG_EMAIL)).toBe(0);
  });

  it("Telegram OAuth sign-in still creates the synthetic-address user", async () => {
    const payload = Buffer.from(JSON.stringify({ id: TG_ID, sub: "x", name: "Tg User" })).toString("base64url");
    const idToken = `e30.${payload}.sig`;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://oauth.telegram.org/.well-known/openid-configuration")) {
        return Response.json({
          issuer: "https://oauth.telegram.org",
          authorization_endpoint: "https://oauth.telegram.org/auth",
          token_endpoint: "https://oauth.telegram.org/token",
        });
      }
      if (url.startsWith("https://oauth.telegram.org/token")) {
        return Response.json({ access_token: "at", token_type: "Bearer", id_token: idToken });
      }
      return realFetch(input, init);
    });

    const auth = await getAuth();
    const start = await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/oauth2`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ providerId: "telegram", callbackURL: "/" }),
      }),
    );
    expect(start.status).toBe(200);
    const state = new URL((await start.json()).url).searchParams.get("state");
    const cookie = start.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; ");

    const done = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/callback/telegram?code=c0de&state=${state}`, { headers: { cookie } }),
    );
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).not.toMatch(/error/);
    expect(await userCount(TG_EMAIL)).toBe(1);
    const { rows } = await pool.query(
      `SELECT 1 FROM account a JOIN "user" u ON u.id = a.user_id WHERE u.email = $1 AND a.provider_id = 'telegram' AND a.account_id = $2`,
      [TG_EMAIL, String(TG_ID)],
    );
    expect(rows).toHaveLength(1);
  });
});
