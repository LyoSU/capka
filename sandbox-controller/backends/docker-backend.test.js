import { describe, it, expect, vi } from "vitest";
import { DockerBackend } from "./docker-backend.js";

// Image present so ensureRuntime() no-ops in unit tests.
const imagePresent = { getImage: () => ({ inspect: async () => ({}) }) };

describe("DockerBackend (mocked dockerode)", () => {
  it("create() builds a container with the configured runtime + labels", async () => {
    const start = vi.fn().mockResolvedValue();
    const createContainer = vi.fn().mockResolvedValue({ id: "c123", start });
    const docker = { ...imagePresent, createContainer };
    const b = new DockerBackend({ docker, image: "img:1", runtime: "runsc" });
    const { handle } = await b.create({
      sessionId: "s1", userId: "u1", wsHostPath: "/w", sharedHostPath: "/s",
      networkMode: "none", memoryBytes: 1, nanoCpus: 1,
    });
    expect(handle).toBe("c123");
    expect(start).toHaveBeenCalled();
    const cfg = createContainer.mock.calls[0][0];
    expect(cfg.HostConfig.Runtime).toBe("runsc");
    expect(cfg.Labels["unclaw.session"]).toBe("s1");
    expect(cfg.Labels["unclaw.user"]).toBe("u1");
  });

  it("list() maps labeled containers to RecoveredSandbox shape", async () => {
    const listContainers = vi.fn().mockResolvedValue([
      { Id: "c1", State: "running", Labels: { "unclaw.session": "s1", "unclaw.user": "u1" } },
      { Id: "c2", State: "exited", Labels: { "unclaw.session": "s2", "unclaw.user": "u2" } },
    ]);
    const b = new DockerBackend({ docker: { ...imagePresent, listContainers }, image: "img:1", runtime: "runc" });
    const out = await b.list();
    expect(out).toEqual([
      { sessionId: "s1", userId: "u1", handle: "c1", running: true },
      { sessionId: "s2", userId: "u2", handle: "c2", running: false },
    ]);
  });

  it("destroy() stops then removes, swallowing already-gone errors", async () => {
    const stop = vi.fn().mockRejectedValue(new Error("not running"));
    const remove = vi.fn().mockResolvedValue();
    const docker = { ...imagePresent, getContainer: () => ({ stop, remove }) };
    const b = new DockerBackend({ docker, image: "img:1" });
    await expect(b.destroy("c1")).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalled();
  });
});
