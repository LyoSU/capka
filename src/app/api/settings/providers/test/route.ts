import { generateText } from "ai";
import { requireRole, apiHandler } from "@/lib/auth";
import { getModel } from "@/lib/providers";

export const POST = apiHandler(async (req: Request) => {
  await requireRole("admin", "user");

  const { provider, apiKey, modelId, baseUrl } = await req.json();
  if (!provider || !modelId) {
    return Response.json({ error: "Missing provider or modelId" }, { status: 400 });
  }

  try {
    const model = getModel(provider, modelId, {
      apiKey: apiKey || undefined,
      baseUrl: baseUrl || undefined,
    });

    const { text } = await generateText({ model, prompt: "Say ok", maxOutputTokens: 20 });
    return Response.json({ success: true, text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return Response.json({ success: false, error: message }, { status: 200 });
  }
});
