import { streamText, APICallError } from "ai";
import { requireRole, apiHandler } from "@/lib/auth";
import { getModel } from "@/lib/providers";
import { assertSafeProviderConfig } from "@/lib/providers/list-models";
import { take } from "@/lib/rate-limit";

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  // This probes an arbitrary baseUrl on the user's behalf — rate-limit so it
  // can't be driven as a scanner.
  const rl = take(`provider-test:${userId}`);
  if (!rl.ok) return Response.json({ error: "Too many requests — please slow down." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const { provider, apiKey, modelId, baseUrl, apiStyle } = await req.json();
  if (!provider || !modelId) {
    return Response.json({ error: "Missing provider or modelId" }, { status: 400 });
  }

  // Bound the whole probe: a custom baseUrl can be a black hole, and a health
  // check must never hang the request indefinitely.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    // SSRF guard BEFORE any outbound request — an unguarded test is a (semi-blind)
    // SSRF primitive.
    await assertSafeProviderConfig(provider, baseUrl);

    const model = getModel(provider, modelId, {
      apiKey: apiKey || undefined,
      baseUrl: baseUrl || undefined,
      // Test over the very transport the saved config will use, so a "tools work?"
      // check isn't a false positive on a different API.
      apiStyle: apiStyle || undefined,
    });

    // Probe over the STREAMING transport — that's the ONLY one real turns use
    // (runner streamText), so it's the universally correct thing to test: a
    // provider that only works non-streaming can't run a turn here anyway. It
    // also avoids falsely rejecting OpenAI-compatible gateways that only stream
    // (e.g. omniroute/cliproxy return SSE unless `stream:false` is sent — a field
    // the SDK omits in doGenerate, so a non-streaming generateText probe 200s).
    // Stream errors surface as an `error` event, not a throw, so re-raise into
    // the catch to keep the status→message mapping.
    const result = streamText({ model, prompt: "Say ok", maxOutputTokens: 20, abortSignal: ac.signal });
    let text = "";
    for await (const event of result.fullStream) {
      if (event.type === "text-delta") text += event.text;
      else if (event.type === "error") throw event.error;
    }
    // An aborted stream ends WITHOUT an error event — our timeout must read as a
    // failure, not a false-positive success.
    if (ac.signal.aborted) throw new Error("timeout");
    return Response.json({ success: true, text });
  } catch (err) {
    // Never echo the upstream RESPONSE BODY: with a custom baseUrl pointed at an
    // internal endpoint this turns the test into a content-exfiltration oracle.
    // Surface only the provider's HTTP status (a non-200 means "reached it,
    // rejected") or a generic connect/credentials/timeout message.
    const error = ac.signal.aborted
      ? "The provider took too long to respond."
      : APICallError.isInstance(err)
        ? err.statusCode === 401 || err.statusCode === 403
          ? "Invalid credentials."
          : err.statusCode
            ? `The provider rejected the request (HTTP ${err.statusCode}).`
            : "Couldn't connect to the provider."
        : "Couldn't connect to the provider.";
    return Response.json({ success: false, error }, { status: 200 });
  } finally {
    clearTimeout(timer);
  }
});
