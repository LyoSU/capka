import { describe, it, expect, vi, afterEach } from "vitest";
import { probeFile, recheckFiles } from "../file-preview";

/**
 * A file chip asks once whether its file is there and then trusts the answer, so a
 * file deleted while the chip stayed mounted kept looking clickable until a remount.
 * recheckFiles is how the page says the workspace may have changed; chips naming the
 * same file must still cost one request between them.
 */
describe("file status probes", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = () => {
    const calls: ((status: number) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      calls.push((status) => resolve(new Response(null, { status })));
    })));
    return calls;
  };
  const file = { path: "report.pdf", name: "report.pdf", chatId: "c1" };

  it("asks once for chips that name the same file", async () => {
    const calls = stubFetch();
    const a = probeFile(file);
    const b = probeFile(file);
    expect(calls).toHaveLength(1);
    calls[0](200);
    expect(await a).toBe("ok");
    expect(await b).toBe("ok");
  });

  it("asks again after a recheck, not trusting an answer that may predate the change", async () => {
    const calls = stubFetch();
    const before = probeFile(file);
    recheckFiles();
    const after = probeFile(file);
    expect(calls).toHaveLength(2);
    calls[0](200);
    calls[1](404);
    expect(await before).toBe("ok");
    expect(await after).toBe("gone");
  });
});
