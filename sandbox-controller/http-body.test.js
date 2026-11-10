import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { parseBody, MAX_BODY, MAX_EXEC_BODY } from "./http-body.js";

/** A request stand-in: a stream of the body in 64 KB chunks, like a socket delivers. */
function req(text) {
  const buf = Buffer.from(text);
  const parts = [];
  for (let i = 0; i < buf.length; i += 65536) parts.push(buf.subarray(i, i + 65536));
  return Readable.from(parts);
}
const execBody = (bytes) => JSON.stringify({ command: `echo '${"A".repeat(bytes)}' | base64 -d > f`, timeout: 30000 });

describe("parseBody", () => {
  it("parses a JSON body, and treats malformed JSON as empty", async () => {
    expect(await parseBody(req('{"command":"ls"}'))).toEqual({ command: "ls" });
    expect(await parseBody(req("{nope"))).toEqual({});
  });

  // The other control endpoints keep their 1 MB guard — only /exec carries data.
  it("still refuses a control body past 1 MB by default", async () => {
    await expect(parseBody(req(execBody(MAX_BODY)))).rejects.toMatchObject({ statusCode: 413 });
  });

  // A write_file of a few MB arrives as base64 inside JSON; at the old 1 MB cap it
  // died with 413 before reaching the sandbox.
  it("admits a multi-MB exec body under the exec cap, byte for byte", async () => {
    const body = execBody(5 * 1024 * 1024);
    const parsed = await parseBody(req(body), MAX_EXEC_BODY);
    expect(parsed.command.length).toBe(5 * 1024 * 1024 + 23);
  });

  it("refuses an exec body past its own cap", async () => {
    await expect(parseBody(req(execBody(MAX_EXEC_BODY)), MAX_EXEC_BODY)).rejects.toMatchObject({ statusCode: 413 });
  });
});
