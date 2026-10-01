import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchModelsShared } from "../model-picker";

/** Several pickers mount in one page load; before the in-flight map each fired its
 *  own `/api/models` request (eight per load, each a provider catalog load). */
describe("fetchModelsShared", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ models: [{ id: "m" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, release };
  }

  it("shares one request between callers with the same key", async () => {
    const { fetchMock, release } = stubFetch();
    const a = fetchModelsShared("active", { mode: "active" });
    const b = fetchModelsShared("active", { mode: "active" });
    expect(a).toBe(b);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ra.data.models).toEqual([{ id: "m" }]);
    expect(rb).toBe(ra);
  });

  it("does not share across keys, and forgets a settled request", async () => {
    const { fetchMock, release } = stubFetch();
    release();
    await Promise.all([
      fetchModelsShared("active", { mode: "active" }),
      fetchModelsShared("cfg:x", { mode: "config", configId: "x" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await fetchModelsShared("active", { mode: "active" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a forced refresh starts its own request and later callers join it", async () => {
    const { fetchMock, release } = stubFetch();
    const old = fetchModelsShared("active", { mode: "active" });
    const forced = fetchModelsShared("active", { mode: "active" }, true);
    expect(forced).not.toBe(old);
    expect(fetchModelsShared("active", { mode: "active" })).toBe(forced);
    release();
    await Promise.all([old, forced]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
