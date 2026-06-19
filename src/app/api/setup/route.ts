import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { providerConfigs, users } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { getSetting, setSetting, isSetupComplete, getMasterKey } from "@/lib/settings";
import { getAuth } from "@/lib/auth";

export async function POST(req: Request) {
  const complete = await isSetupComplete();
  if (complete) {
    return Response.json({ error: "Setup already complete" }, { status: 403 });
  }

  const body = await req.json();
  const { step } = body;

  if (step === "account") {
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
    // Anti-hijack: the admin email is claimed once and never reassigned. But a
    // re-run by the SAME signed-in admin (e.g. a page refresh mid-setup) is
    // idempotent — only a different account is rejected.
    const existing = await getSetting("admin_email");
    if (existing && existing !== email) {
      return Response.json({ error: "Admin account already configured" }, { status: 403 });
    }
    if (!existing) await setSetting("admin_email", email);
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
    if (!provider) {
      return Response.json({ error: "Missing provider" }, { status: 400 });
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
    // Verify this is the admin email from step 1
    const adminEmail = await getSetting("admin_email");
    if (adminEmail && session.user.email !== adminEmail) {
      return Response.json({ error: "Only the admin account can complete setup" }, { status: 403 });
    }
    await db.update(users).set({ role: "admin" }).where(eq(users.id, session.user.id));
    await setSetting("setup_complete", "true");
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown step" }, { status: 400 });
}
