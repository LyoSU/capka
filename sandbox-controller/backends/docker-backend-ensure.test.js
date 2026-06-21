import { describe, it, expect, vi } from "vitest";
import { DockerBackend } from "./docker-backend.js";

function makeDocker({ present }) {
  let exists = present;
  return {
    getImage: () => ({
      inspect: async () => {
        if (!exists) { const e = new Error("no such image"); e.statusCode = 404; throw e; }
        return {};
      },
    }),
    pull: vi.fn(async () => { exists = true; return {}; }),
    modem: { followProgress: (s, cb) => cb(null, []) },
  };
}

describe("ensureRuntime", () => {
  it("no-ops when image present", async () => {
    const docker = makeDocker({ present: true });
    const b = new DockerBackend({ docker, image: "img:1", runtime: "runc" });
    await b.ensureRuntime();
    expect(docker.pull).not.toHaveBeenCalled();
  });

  it("pulls when image missing", async () => {
    const docker = makeDocker({ present: false });
    const b = new DockerBackend({ docker, image: "img:1", runtime: "runc" });
    await b.ensureRuntime();
    expect(docker.pull).toHaveBeenCalledTimes(1);
  });

  it("dedups concurrent calls into one pull", async () => {
    const docker = makeDocker({ present: false });
    const b = new DockerBackend({ docker, image: "img:1", runtime: "runc" });
    await Promise.all([b.ensureRuntime(), b.ensureRuntime(), b.ensureRuntime()]);
    expect(docker.pull).toHaveBeenCalledTimes(1);
  });

  it("caches success — second call does not re-pull", async () => {
    const docker = makeDocker({ present: false });
    const b = new DockerBackend({ docker, image: "img:1", runtime: "runc" });
    await b.ensureRuntime();
    await b.ensureRuntime();
    expect(docker.pull).toHaveBeenCalledTimes(1);
  });
});
