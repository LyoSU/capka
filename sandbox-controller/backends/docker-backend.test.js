import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
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
    expect(cfg.Labels["capka.session"]).toBe("s1");
    expect(cfg.Labels["capka.user"]).toBe("u1");
  });

  // The whole allowlist feature rides on this one line of plumbing: the endpoint is
  // handed to create() by the server, and if create() drops it the container takes
  // the OPEN-egress branch of the entrypoint instead — on a network whose proxy sits
  // in a private range those rules DROP, so the sandbox ends up with no egress at
  // all and no explanation. The label check is the load-bearing half: a created
  // container whose posture label disagrees with fingerprint() looks stale to
  // reconcile forever, which recreates every gated sandbox on every boot.
  it("create() carries the egress proxy into the container, and labels it what reconcile expects", async () => {
    const start = vi.fn().mockResolvedValue();
    const createContainer = vi.fn().mockResolvedValue({ id: "c1", start });
    const docker = { ...imagePresent, createContainer };
    const b = new DockerBackend({ docker, image: "img:1", runtime: "runc" });
    await b.create({
      sessionId: "s1", userId: "u1", wsHostPath: "/w", sharedHostPath: "/s",
      networkMode: "capka-sandbox-egress", egressProxy: "capka-egress-proxy:3128",
    });
    const cfg = createContainer.mock.calls[0][0];
    expect(cfg.Env).toContain("SANDBOX_EGRESS_PROXY=capka-egress-proxy:3128");
    expect(cfg.Labels["capka.spec"]).toBe(b.fingerprint({}, "capka-sandbox-egress", "capka-egress-proxy:3128"));
  });

  it("create() self-heals a stale name conflict — force-removes the leftover container and retries", async () => {
    const start = vi.fn().mockResolvedValue();
    // A prior container crashed and was never reaped; its fixed name blocks the new one.
    const createContainer = vi.fn()
      .mockRejectedValueOnce(new Error('Conflict. The container name "/sandbox-s1" is already in use by container "old123"'))
      .mockResolvedValue({ id: "c-new", start });
    const remove = vi.fn().mockResolvedValue();
    const getContainer = vi.fn(() => ({ remove }));
    const docker = { ...imagePresent, createContainer, getContainer };
    const b = new DockerBackend({ docker, image: "img:1", runtime: "runsc" });
    const { handle } = await b.create({
      sessionId: "s1", userId: "u1", wsHostPath: "/w", sharedHostPath: "/s",
      networkMode: "none", memoryBytes: 1, nanoCpus: 1,
    });
    expect(handle).toBe("c-new");
    expect(getContainer).toHaveBeenCalledWith("sandbox-s1");
    expect(remove).toHaveBeenCalledWith({ force: true });
    expect(createContainer).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalled();
  });

  it("list() maps labeled containers to RecoveredSandbox shape", async () => {
    const listContainers = vi.fn().mockResolvedValue([
      { Id: "c1", State: "running", Labels: { "capka.session": "s1", "capka.user": "u1" } },
      { Id: "c2", State: "exited", Labels: { "capka.session": "s2", "capka.user": "u2" } },
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
  /** A container whose execs stay in flight until the test ends their stream, so
   *  an exec can be inspected (and cancelled) while it is still running. */
  function inFlightContainer() {
    const cmds = [];
    const streams = [];
    const exec = vi.fn(async (opts) => {
      cmds.push(opts.Cmd[2]);
      const stream = new EventEmitter();
      stream.resume = () => {};
      streams.push(stream);
      return { start: (_o, cb) => cb(null, stream), inspect: async () => ({ ExitCode: 137 }) };
    });
    return { container: { exec }, cmds, streams, exec };
  }

  it("exec() publishes its process-group id so a cancel has something to kill", async () => {
    const { container, cmds } = inFlightContainer();
    const b = new DockerBackend({ docker: { ...imagePresent, getContainer: () => container }, image: "img:1" });
    b.exec("c1", "sleep 300", 300000).catch(() => {});
    await vi.waitFor(() => expect(cmds.length).toBe(1));
    // Per-exec file, under a fixed dir on the sandbox's own tmpfs.
    expect(cmds[0]).toMatch(/mkdir -p \/tmp\/\.capka-exec/);
    expect(cmds[0]).toMatch(/echo "\$__pid" > \/tmp\/\.capka-exec\/[0-9a-f-]{36}/);
    // ...and removes it on the way out, so /tmp doesn't fill with dead pids.
    expect(cmds[0]).toMatch(/rm -f \/tmp\/\.capka-exec\//);
  });

  it("exec() aborted mid-run kills the whole group from a second exec", async () => {
    const { container, cmds, streams, exec } = inFlightContainer();
    const b = new DockerBackend({
      docker: { ...imagePresent, getContainer: () => container },
      image: "img:1", sandboxUser: "1000:1000",
    });

    const ac = new AbortController();
    const p = b.exec("c1", "sleep 300", 300000, ac.signal);
    await vi.waitFor(() => expect(cmds.length).toBe(1));
    const pidFile = cmds[0].match(/echo "\$__pid" > (\S+)/)[1];

    ac.abort();
    await vi.waitFor(() => expect(cmds.length).toBe(2));
    // The kill reads THAT exec's pid file and signals the process GROUP (leading
    // "-"), matching what the timeout killer does — and waits for the file, so a
    // cancel racing the wrapper's first milliseconds still lands.
    expect(cmds[1]).toContain(pidFile);
    expect(cmds[1]).toContain('kill -KILL -"$__p"');
    expect(cmds[1]).toMatch(/while \[ ! -s /);
    // Same user as the command, or the signal wouldn't be permitted.
    expect(exec.mock.calls[1][0].User).toBe("1000:1000");

    // The exec itself still settles normally once the container-side group is gone.
    streams[0].emit("end");
    await expect(p).resolves.toMatchObject({ exitCode: 137 });
  });

  it("exec() that finishes on its own never issues a kill", async () => {
    const { container, cmds, streams } = inFlightContainer();
    const b = new DockerBackend({ docker: { ...imagePresent, getContainer: () => container }, image: "img:1" });
    const ac = new AbortController();
    const p = b.exec("c1", "echo hi", 30000, ac.signal);
    await vi.waitFor(() => expect(cmds.length).toBe(1));
    streams[0].emit("end");
    await p;
    // Aborting AFTER the command is done must not reach into the container: the
    // listener is gone, so a later cancel (or the next turn's) kills nothing.
    ac.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(cmds.length).toBe(1);
  });
});
