import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { setSetting, isSetupComplete, getMasterKey } from "@/lib/settings";

export async function POST(req: Request) {
  const complete = await isSetupComplete();
  if (complete) {
    return NextResponse.json({ error: "Setup already complete" }, { status: 403 });
  }

  const body = await req.json();
  const { step } = body;

  if (step === "account") {
    const { email } = body;
    if (!email) {
      return NextResponse.json({ error: "Missing email" }, { status: 400 });
    }
    await setSetting("admin_email", email);
    return NextResponse.json({ ok: true });
  }

  if (step === "provider") {
    const { userId, provider, apiKey, baseUrl, defaultModel } = body;
    if (!userId || !provider) {
      return NextResponse.json({ error: "Missing userId or provider" }, { status: 400 });
    }

    const masterKey = await getMasterKey();
    const encryptedKey = apiKey ? encrypt(apiKey, masterKey) : null;

    // Deactivate existing configs for this user
    await db
      .update(providerConfigs)
      .set({ isActive: false })
      .where(eq(providerConfigs.userId, userId));

    const id = nanoid();
    await db.insert(providerConfigs).values({
      id,
      userId,
      provider,
      apiKey: encryptedKey,
      baseUrl: baseUrl || null,
      defaultModel: defaultModel || null,
      isActive: true,
    });

    return NextResponse.json({ ok: true });
  }

  if (step === "complete") {
    await setSetting("setup_complete", "true");
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown step" }, { status: 400 });
}
