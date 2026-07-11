import { buildSandboxConfig } from "../sandbox-spec.js";
import { createFrameDemux } from "../docker-frames.js";

/** ComputeBackend implementation over the Docker daemon (via dockerode).
 *  Lifts createSandbox/execInSandbox/destroySandbox/recoverSessions out of the
 *  old server.js. The workspace bind paths arrive already host-resolved in the
 *  spec (the core builds them via WorkspaceStore.ensure). */
export class DockerBackend {
  constructor({ docker, image, runtime, execTimeoutMs = 30000, sandboxUser = "1000:1000" }) {
    this.docker = docker;
    this.image = image;
    this.runtime = runtime;
    this.execTimeoutMs = execTimeoutMs;
    this.sandboxUser = sandboxUser;
    this._ensured = false;
    this._ensuring = null;
  }

  /** Guarantee the sandbox image exists before create. Idempotent; dedups
   *  concurrent calls into one pull. Self-heals after an image prune. */
  async ensureRuntime() {
    if (this._ensured) return;
    if (this._ensuring) return this._ensuring;
    this._ensuring = (async () => {
      try {
        await this.docker.getImage(this.image).inspect();
      } catch (e) {
        if (e.statusCode !== 404) throw e;
        const stream = await this.docker.pull(this.image);
        await new Promise((res, rej) =>
          this.docker.modem.followProgress(stream, (err) => (err ? rej(err) : res())));
      }
      this._ensured = true;
    })().finally(() => { this._ensuring = null; });
    return this._ensuring;
  }

  /** True once the sandbox image is confirmed present (prewarm finished, or a
   *  prior create pulled it). False while the first multi-GB pull is still in
   *  flight — the create route uses this to answer "still preparing" instead of
   *  blocking a client request for minutes. */
  runtimeReady() {
    return this._ensured;
  }

  /** Wait up to `ms` for the image to become ready, kicking the (idempotent,
   *  deduped) pull if it isn't already running. Resolves true if ready in time,
   *  false if the pull is still going (or failed) — so the caller can 503 with a
   *  "preparing" message well under the client's request timeout rather than
   *  letting a fresh-box first pull abort it. */
  async awaitRuntime(ms) {
    if (this._ensured) return true;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
    const ready = this.ensureRuntime().then(() => true, () => false);
    try {
      return await Promise.race([ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async create(spec) {
    await this.ensureRuntime();
    const config = buildSandboxConfig({
      image: this.image,
      runtime: this.runtime,
      sessionId: spec.sessionId,
      userId: spec.userId,
      wsHostPath: spec.wsHostPath,
      sharedHostPath: spec.sharedHostPath,
      networkMode: spec.networkMode,
      memoryBytes: spec.memoryBytes,
      nanoCpus: spec.nanoCpus,
      pidsLimit: spec.pidsLimit,
      tmpMb: spec.tmpMb,
      mcpTmpMb: spec.mcpTmpMb,
      fsizeBytes: spec.fsizeBytes,
      mounts: spec.mounts,
    });

    let container;
    try {
      container = await this.docker.createContainer(config);
    } catch (e) {
      // Self-heal: image vanished between ensureRuntime and create (prune race).
      if (/no such image/i.test(e.message)) {
        this._ensured = false;
        await this.ensureRuntime();
        container = await this.docker.createContainer(config);
      } else if (/already in use/i.test(e.message)) {
        // A prior container with this session's fixed name crashed and was never
        // reaped, so its name blocks the new one. We ARE the session's owner
        // (re)creating it, so force-remove the stale husk and retry — otherwise the
        // session is wedged forever on a 409 name conflict.
        await this.docker.getContainer(config.name).remove({ force: true }).catch(() => {});
        container = await this.docker.createContainer(config);
      } else {
        throw e;
      }
    }
    await container.start();
    return { handle: container.id };
  }

  async exec(handle, command, timeoutMs = this.execTimeoutMs) {
    const container = this.docker.getContainer(handle);

    // Run the command in its own session so a timeout kills the whole process
    // group (forked children included). base64 keeps the command verbatim.
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const b64 = Buffer.from(command).toString("base64");
    const wrapper =
      `__cmd=$(echo ${b64} | base64 -d); ` +
      `setsid bash -c "$__cmd" & __pid=$!; ` +
      `( sleep ${secs}; kill -KILL -"$__pid" 2>/dev/null ) & __killer=$!; ` +
      `wait "$__pid"; __rc=$?; ` +
      `kill "$__killer" 2>/dev/null; wait "$__killer" 2>/dev/null; ` +
      `exit $__rc`;

    const execObj = await container.exec({
      Cmd: ["bash", "-c", wrapper],
      AttachStdout: true,
      AttachStderr: true,
      User: this.sandboxUser,
      WorkingDir: "/workspace",
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs + 5000);
      execObj.start({ hijack: true }, (err, stream) => {
        if (err) { clearTimeout(timer); return reject(err); }
        // Buffer frames across 'data' events — they are NOT chunk-aligned.
        const demux = createFrameDemux();
        stream.on("data", (chunk) => demux.push(chunk));
        stream.on("end", async () => {
          clearTimeout(timer);
          // The demux already bounds what it keeps (RAM guard) and flags an
          // overflow as `truncated` — so no post-hoc .slice() is needed here.
          const { stdout, stderr, truncated } = demux.result();
          try {
            const info = await execObj.inspect();
            resolve({ stdout, stderr, exitCode: info.ExitCode, truncated });
          } catch {
            resolve({ stdout, stderr, exitCode: -1, truncated });
          }
        });
        stream.on("error", (e) => { clearTimeout(timer); reject(e); });
      });
    });
  }

  async destroy(handle) {
    try {
      const container = this.docker.getContainer(handle);
      await container.stop({ t: 5 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
    } catch { /* already gone */ }
  }

  /** Sandboxes labeled by the controller, keyed by sessionId for reconcile. */
  async list() {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ["capka.session"] },
    });
    return containers.map((c) => ({
      sessionId: c.Labels["capka.session"],
      userId: c.Labels["capka.user"],
      handle: c.Id,
      running: c.State === "running",
    }));
  }
}
