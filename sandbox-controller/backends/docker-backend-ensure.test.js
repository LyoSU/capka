import { describe, it, expect, vi } from "vitest";
import { DockerBackend } from "./docker-backend.js";

/**
 * Image freshness is a SECURITY property here, not housekeeping: the sandbox's
 * own default-deny firewall lives in the execution image's entrypoint, so a
 * controller upgraded to a release with new rules while still running last
 * release's image silently applies the old ones. ensureRuntime used to pull only
 * when the image was missing entirely, and SECURITY.md documented the resulting
 * drift instead of fixing it.
 *
 * The trap on the way to fixing it is the same bug pointing the other way: a
 * from-source stack BUILDS `capka-sandbox:latest` locally, where a pull replaces
 * the operator's build with the published image. A registry-sourced image carries
 * RepoDigests; a locally built one does not.
 */
function makeDocker({ present, afterPull, pullFails = false } = {}) {
  let current = present ?? null;
  return {
    getImage: () => ({
      inspect: async () => {
        if (!current) { const e = new Error("no such image"); e.statusCode = 404; throw e; }
        return current;
      },
    }),
    pull: vi.fn(async () => {
      if (pullFails) throw new Error("registry unreachable");
      current = afterPull ?? current ?? { Id: "sha256:pulled", RepoDigests: ["r@sha256:pulled"] };
      return {};
    }),
    modem: { followProgress: (s, cb) => cb(null, []) },
  };
}

const backendFor = (docker) => new DockerBackend({ docker, image: "img:1", runtime: "runc" });

describe("ensureRuntime", () => {
  it("no-ops when a LOCALLY BUILT image is present", async () => {
    // No RepoDigests ⇒ this tag points at a local build. Pulling would swap the
    // operator's own sandbox image for the published one, silently.
    const docker = makeDocker({ present: { Id: "sha256:builthere", RepoDigests: [] } });
    const b = backendFor(docker);
    await b.ensureRuntime();
    expect(docker.pull).not.toHaveBeenCalled();
    expect(b.imageRef()).toBe("sha256:builthere");
  });

  it("refreshes an image that came from a registry", async () => {
    // "Already present" is not "already current": `:latest` is how nearly every
    // deployment names this image.
    const docker = makeDocker({
      present: { Id: "sha256:old", RepoDigests: ["r@sha256:old"] },
      afterPull: { Id: "sha256:new", RepoDigests: ["r@sha256:new"] },
    });
    const b = backendFor(docker);
    await b.ensureRuntime();
    expect(docker.pull).toHaveBeenCalledTimes(1);
    expect(b.imageRef()).toBe("sha256:new");
  });

  it("pulls when image missing", async () => {
    const docker = makeDocker({ present: null });
    const b = backendFor(docker);
    await b.ensureRuntime();
    expect(docker.pull).toHaveBeenCalledTimes(1);
    expect(b.imageRef()).toBe("sha256:pulled");
  });

  it("keeps serving the image it has when the refresh fails", async () => {
    // A registry outage must not take a working stack's sandboxes down with it.
    const docker = makeDocker({ present: { Id: "sha256:old", RepoDigests: ["r@sha256:old"] }, pullFails: true });
    const b = backendFor(docker);
    await expect(b.ensureRuntime()).resolves.toBeUndefined();
    expect(b.imageRef()).toBe("sha256:old");
  });

  it("still fails when there is no image AND the pull fails", async () => {
    // Nothing to fall back on: a create would fail anyway, so readiness must not
    // claim the runtime is prepared.
    const docker = makeDocker({ present: null, pullFails: true });
    await expect(backendFor(docker).ensureRuntime()).rejects.toThrow(/registry unreachable/);
  });

  it("dedups concurrent calls into one pull", async () => {
    const docker = makeDocker({ present: null });
    const b = backendFor(docker);
    await Promise.all([b.ensureRuntime(), b.ensureRuntime(), b.ensureRuntime()]);
    expect(docker.pull).toHaveBeenCalledTimes(1);
  });

  it("caches success — second call does not re-pull", async () => {
    const docker = makeDocker({ present: null });
    const b = backendFor(docker);
    await b.ensureRuntime();
    await b.ensureRuntime();
    expect(docker.pull).toHaveBeenCalledTimes(1);
  });
});

describe("resolveImage — the cheap, network-free half", () => {
  it("records the id from a local inspect without pulling", async () => {
    // Boot reconciliation runs BEFORE the (possibly multi-GB) prewarm on purpose.
    // It still needs the real current id, or it compares live containers against a
    // posture keyed on the tag and finds nothing stale.
    const docker = makeDocker({ present: { Id: "sha256:local", RepoDigests: ["r@sha256:local"] } });
    const b = backendFor(docker);
    await b.resolveImage();
    expect(docker.pull).not.toHaveBeenCalled();
    expect(b.imageRef()).toBe("sha256:local");
  });

  it("falls back to the configured tag when no image is present yet", async () => {
    // A fresh box: nothing to reconcile, so a tag-keyed posture is harmless.
    const b = backendFor(makeDocker({ present: null }));
    await b.resolveImage();
    expect(b.imageRef()).toBe("img:1");
  });
});

describe("the container posture follows the image bytes", () => {
  const env = { memoryBytes: 1024, nanoCpus: 1, pidsLimit: 256 };

  it("changes the fingerprint when the resolved image changes", async () => {
    // Without this the refresh is cosmetic: reconcile would keep adopting
    // containers built from the previous execution image — the one whose
    // entrypoint carries the previous firewall.
    const before = backendFor(makeDocker({ present: { Id: "sha256:old", RepoDigests: ["r@sha256:old"] } }));
    const after = backendFor(makeDocker({ present: { Id: "sha256:new", RepoDigests: ["r@sha256:new"] } }));
    await before.resolveImage();
    await after.resolveImage();
    expect(before.fingerprint(env, "none")).not.toBe(after.fingerprint(env, "none"));
  });

  it("is stable for the same image across calls", async () => {
    // The other failure mode: an unstable fingerprint makes every sandbox look
    // outdated on every boot, so reconcile recreates all of them forever.
    const b = backendFor(makeDocker({ present: { Id: "sha256:same", RepoDigests: ["r@sha256:same"] } }));
    await b.resolveImage();
    expect(b.fingerprint(env, "none")).toBe(b.fingerprint(env, "none"));
  });

  it("create() runs the resolved image, not the tag", async () => {
    const createContainer = vi.fn().mockResolvedValue({ id: "c1", start: vi.fn().mockResolvedValue() });
    const docker = { ...makeDocker({ present: { Id: "sha256:bytes", RepoDigests: ["r@sha256:bytes"] } }), createContainer };
    const b = backendFor(docker);
    await b.create({
      sessionId: "s1", userId: "u1", wsHostPath: "/w", sharedHostPath: "/s",
      networkMode: "none", memoryBytes: 1, nanoCpus: 1,
    });
    expect(createContainer.mock.calls[0][0].Image).toBe("sha256:bytes");
  });
});
