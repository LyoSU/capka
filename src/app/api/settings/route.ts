import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";

export async function GET(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");
  if (!key) return Response.json({ error: "Missing key" }, { status: 400 });

  const value = await getSetting(key);
  return Response.json({ key, value });
}

export async function PUT(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { key, value, encrypted } = await req.json();
  if (!key || value === undefined) {
    return Response.json({ error: "Missing key or value" }, { status: 400 });
  }

  await setSetting(key, value, encrypted ?? false);
  return Response.json({ ok: true });
}
