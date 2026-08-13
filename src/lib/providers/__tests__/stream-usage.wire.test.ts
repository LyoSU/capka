import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { streamText } from "ai";
import { getModel } from "..";
import { disableStreamUsage } from "../stream-usage";

/**
 * The contract this whole mechanism rests on, checked on the WIRE rather than
 * against a mock: a real OpenAI-compatible SSE exchange over loopback, with the
 * request bodies captured as the SDK actually sent them.
 *
 * Two things can only be verified here. That `includeUsage` reaches the request
 * body at all (it is an SDK construction option two layers below our code), and
 * that a usage-only final chunk — `choices: []`, which is what a server sends when
 * asked — is parsed into the numbers the turn is billed on. A stubbed provider
 * would have proven neither.
 */
let server: Server;
let baseUrl: string;
let bodies: Array<Record<string, unknown>>;

/** A minimal streamed completion, ending with the usage-only chunk. */
const SSE = [
  `data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}`,
  `data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  `data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}`,
  `data: [DONE]`,
  ``,
].join("\n\n");

beforeAll(async () => {
  bodies = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function streamOnce(connectionId: string) {
  const result = streamText({
    model: getModel("litellm", "m", { apiKey: "k", baseUrl, connectionId }),
    prompt: "hi",
  });
  await result.consumeStream();
  return result;
}

describe("token usage over an OpenAI-compatible stream", () => {
  it("asks for usage and reads the counts back off the final chunk", async () => {
    const result = await streamOnce(randomUUID());

    // The ask, as the server received it.
    expect(bodies.at(-1)?.stream_options).toEqual({ include_usage: true });
    // And the point of asking: real numbers instead of the zeros a turn was
    // recorded, billed and traced with before.
    const usage = await result.totalUsage;
    expect(usage.inputTokens).toBe(11);
    expect(usage.outputTokens).toBe(3);
  });

  it("drops the ask on the next request once the endpoint has refused it", async () => {
    // What the runner's retry does after a rejection: the SAME model instance must
    // now send a body the endpoint accepts, without being rebuilt.
    const connectionId = randomUUID();
    await streamOnce(connectionId);
    expect(bodies.at(-1)?.stream_options).toEqual({ include_usage: true });

    disableStreamUsage(connectionId);
    await streamOnce(connectionId);
    expect(bodies.at(-1)).not.toHaveProperty("stream_options");
  });
});
