import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { setSetting, isSetupComplete, getMasterKey } from "@/lib/settings";
import { getAuth } from "@/lib/auth";

export async function POST(req: Request) {
  const complete = await isSetupComplete();
  if (complete) {
    return Response.json({ error: "Setup already complete" }, { status: 403 });
  }

  const body = await req.json();
  const { step } = body;

  if (step === "account") {
    const { email } = body;
    if (!email) {
      return Response.json({ error: "Missing email" }, { status: 400 });
    }
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
    await setSetting("setup_complete", "true");
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown step" }, { status: 400 });
}
