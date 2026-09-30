import { expect } from "vitest";

/**
 * What every prompt a turn sends has to hold, whichever road built it — the turn
 * context, a steer, an effect note, a continuation, a restart. Read off the prompt
 * the model was handed, so it counts what the provider package would.
 */
type Marked = { providerOptions?: { anthropic?: { cacheControl?: unknown } } };
export type WireMsg = Marked & { role: string; content: unknown };

/** Anthropic breakpoints as its provider places them: a part's own marker, else the
 *  message's, which lands on the message's last part. */
export function breakpoints(prompt: WireMsg[]): number {
  let n = 0;
  for (const m of prompt) {
    const parts = (Array.isArray(m.content) ? m.content : []) as Marked[];
    n += parts.filter((p) => p.providerOptions?.anthropic?.cacheControl).length;
    if (m.providerOptions?.anthropic?.cacheControl && !parts.at(-1)?.providerOptions?.anthropic?.cacheControl) n++;
  }
  return n;
}

/** Strict chat templates 400 on two user messages in a row; Anthropic allows four breakpoints. */
export function expectWireShape(prompt: WireMsg[]) {
  expect(prompt.filter((m, i) => m.role === "user" && prompt[i - 1]?.role === "user")).toEqual([]);
  expect(breakpoints(prompt)).toBeLessThanOrEqual(4);
}
