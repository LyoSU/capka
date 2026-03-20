import { headers } from "next/headers";
import { generateText } from "ai";
import { getAuth } from "@/lib/auth";
import { getModel } from "@/lib/providers";

export async function POST(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { provider, apiKey, modelId, baseUrl } = await req.json();
  if (!provider || !modelId) {
    return Response.json({ error: "Missing provider or modelId" }, { status: 400 });
  }

  try {
    const model = getModel(provider, modelId, {
      apiKey: apiKey || undefined,
      baseUrl: baseUrl || undefined,
    });

    const { text } = await generateText({ model, prompt: "Say ok", maxOutputTokens: 10 });
    return Response.json({ success: true, text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return Response.json({ success: false, error: message }, { status: 200 });
  }
}
