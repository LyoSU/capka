import { nanoid } from "nanoid";
import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { providerConfigs, users } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { getSetting, setSetting, isSetupComplete, getMasterKey } from "@/lib/settings";
import { getAuth } from "@/lib/auth";
import { PROVIDERS } from "@/lib/providers";

/**
 * Optional bootstrap hardening (advanced, opt-in via the SETUP_TOKEN env var).
 * When set, claiming the admin account requires presenting it — so a stranger
 * who races to a fresh, internet-reachable deploy can't seize admin. When UNSET
 * (the default) first-run is frictionless: whoever runs setup becomes admin,
 * which is fine for the common local / trusted-network install. Returns true
 * when no token is configured (gate disabled) or the provided one matches.
 */
function setupTokenOk(provided: unknown): boolean {
  const expected = process.env.SETUP_TOKEN?.trim();
  if (!expected) return true;
  if (typeof provided !== "string" || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const complete = await isSetupComplete();
  if (complete) {
    return Response.json({ error: "Setup already complete" }, { status: 403 });
  }

  const body = await req.json();
  const { step } = body;

  if (step === "account") {
    // If the operator opted into the SETUP_TOKEN hardening, claiming admin
    // requires presenting it (checked here, on the admin-email claim; the later
    // "complete" step is bound to that email, so it inherits the gate). When no
    // token is configured this is a no-op and first-run stays frictionless.
    if (!setupTokenOk(body.setupToken)) {
      return Response.json({ error: "Invalid setup token." }, { status: 403 });
    }

    // Require auth — prevents remote pre-claiming of admin email
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    const email = session.user.email;
    if (!email) {
      return Response.json({ error: "Account has no email" }, { status: 400 });
    }
    // Setup is NOT complete here (guarded at the top) and the SETUP_TOKEN gate
    // (when configured) already passed above — so there is no real admin yet to
    // protect. Always (re)bind the bootstrap email to the CURRENT authenticated
    // session. Pinning it permanently the first time was a footgun: a half-
    // finished setup (e.g. the provider step failed, then the session was lost to
    // a non-secure cookie that never round-tripped) left admin_email stuck on an
    // account the operator could no longer sign into — so a fresh attempt with a
    // different email dead-ended on "Admin account already configured". Letting it
    // be re-claimed until completion keeps first-run recoverable; the SETUP_TOKEN
    // (or the trusted-network trust model when it's unset) remains the real gate.
    await setSetting("admin_email", email);
    return Response.json({ ok: true });
  }

  if (step === "provider") {
    // Validate userId from session — don't trust client
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }

    const userId = session.user.id;
    const { provider, apiKey, baseUrl, defaultModel } = body;
    if (!provider || !PROVIDERS.includes(provider)) {
      return Response.json({ error: "Invalid or missing provider" }, { status: 400 });
    }
    if (baseUrl) {
      try {
        const p = new URL(String(baseUrl)).protocol;
        if (p !== "http:" && p !== "https:") throw new Error("scheme");
      } catch {
        return Response.json({ error: "Base URL must be a valid http(s) URL." }, { status: 400 });
      }
    }

    const masterKey = await getMasterKey();
    const encryptedKey = apiKey ? encrypt(apiKey, masterKey) : null;

    await db
      .update(providerConfigs)
      .set({ isActive: false })
      .where(eq(providerConfigs.userId, userId));

    await db.insert(providerConfigs).values({
      id: nanoid(),
      userId,
      provider,
      apiKey: encryptedKey,
      baseUrl: baseUrl || null,
      defaultModel: defaultModel || null,
      isActive: true,
    });

    return Response.json({ ok: true });
  }

  if (step === "complete") {
    // Require authenticated session to finish setup — prevents unauthenticated lockout
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return Response.json({ error: "Must be signed in to complete setup" }, { status: 401 });
    }
    // Verify this is the admin email claimed in step 1. The `account` step MUST
    // have run first: without `admin_email` set there is no bootstrap owner to
    // match against, so a `!adminEmail` short-circuit would let ANY signed-in
    // account (email signup is open pre-setup) promote itself to admin and lock
    // out the real operator. Refuse until the account step has claimed the email.
    const adminEmail = await getSetting("admin_email");
    if (!adminEmail || session.user.email !== adminEmail) {
      return Response.json({ error: "Complete the account step first, then finish setup from that same account." }, { status: 403 });
    }
    await db.update(users).set({ role: "admin" }).where(eq(users.id, session.user.id));
    await setSetting("setup_complete", "true");
    // Arm the one-time first-run concierge: the runner consumes this on the admin's
    // first chat turn to welcome them and offer to configure the optional bits.
    await setSetting("concierge_pending", session.user.id);
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown step" }, { status: 400 });
}
