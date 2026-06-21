# Isolated Compute Layer — Implementation Plan (Stage 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `sandbox-controller` into a hexagonal shape (ports `ComputeBackend` + `WorkspaceStore`, durable `SessionStore`), make sandboxes strongly isolated by default (Docker + gVisor + hardening, fail-closed), and make the image lifecycle self-healing — without changing the HTTP contract with the platform.

**Architecture:** The HTTP core (routing, auth, quotas, idle/eviction, recovery, GC) stays and calls two ports. `DockerBackend` (gVisor runtime + hardening) implements `ComputeBackend`; `LocalFsStore` implements `WorkspaceStore` (current local behavior behind the interface). Session state moves from an in-memory `Map` to Postgres with an in-process `lastActivity` cache. `S3Store`, Kubernetes, and Managed backends are explicitly out of scope (Stage 2+).

**Tech Stack:** Node.js ESM (`"type":"module"`), `dockerode`, `pg`, Vitest (run from repo root), Docker + gVisor (`runsc`), Postgres 17.

**Spec:** `docs/superpowers/specs/2026-06-21-isolated-compute-layer-design.md`

## Global Constraints

- Node ESM only (`import`/`export`); controller has no transpile step. Copy verbatim: `"type": "module"`.
- Run tests from repo root: `npx vitest run sandbox-controller/<file>.test.js`. Never `cd` into a subdir to test.
- HTTP contract (paths, status codes, JSON shapes of `/sessions`, `/sessions/:id/exec`, `/files`, `/download`, `/upload`, `/health`) MUST NOT change — the platform client depends on it.
- Ports are JS objects; "interface" = JSDoc typedef + a shared contract-test suite every implementation must pass.
- Fail-closed: when `SANDBOX_RUNTIME=runsc` (profile `secure`, the default) and `runsc` is unavailable, the controller exits non-zero at boot — never silently falls back to `runc`.
- Default isolation runtime is gVisor `runsc`; `SANDBOX_RUNTIME=runc` is an explicit dev/trusted opt-in only.
- Image reference is pinned: `SANDBOX_IMAGE` carries an explicit tag/digest; `latest` is dev-only.
- Sandbox containers never receive the controller's env or the Docker socket.
- Secrets have no defaults in prod: `CONTROLLER_SECRET`, `DATABASE_URL` required.

---

## File Structure

**Create:**
- `sandbox-controller/stores/local-fs-store.js` — `LocalFsStore` (`WorkspaceStore` impl): ensure/list/read/write/size/remove over the local data dir.
- `sandbox-controller/stores/workspace-store.contract.js` — shared contract test suite for any `WorkspaceStore`.
- `sandbox-controller/stores/workspace-factory.js` — picks a store by `WORKSPACE_STORE` (`local` only for now).
- `sandbox-controller/backends/docker-backend.js` — `DockerBackend` (`ComputeBackend` impl): ensureRuntime/create/exec/destroy/list + host-path/bind logic.
- `sandbox-controller/backends/compute-backend.contract.js` — shared contract test suite for any `ComputeBackend`.
- `sandbox-controller/backends/backend-factory.js` — picks a backend by `COMPUTE_BACKEND` (`docker` only for now).
- `sandbox-controller/session-store.js` — `PostgresSessionStore` + in-process `lastActivity` cache; idempotent `CREATE TABLE IF NOT EXISTS`.
- `sandbox-controller/runtime-check.js` — gVisor availability probe + readiness gate state.
- `sandbox-controller/reconcile.js` — boot reconcile (DB ⟷ backend) state machine.
- `sandbox-controller/gc.js` — orphaned-workspace garbage collector.
- `scripts/install-gvisor.sh` — host installer (runsc + daemon.json + userns-remap).

**Modify:**
- `sandbox-controller/server.js` — slim to: wiring (factories), HTTP routing, auth, quotas, idle/eviction, readiness; delegate compute→backend, files→store, state→session-store.
- `sandbox-controller/sandbox-spec.js` — add `runtime` + hardening fields to `buildSandboxConfig`.
- `sandbox-controller/package.json` — add `pg` dependency.
- `docker-compose.yml` + `docker-compose.coolify.yml` — `socket-proxy` `IMAGES=1`; controller env (`DATABASE_URL`, `COMPUTE_BACKEND`, `WORKSPACE_STORE`, `SANDBOX_RUNTIME`, pinned `SANDBOX_IMAGE`); ghcr-pull for sandbox.

**Existing modules reused as-is:** `path-safety.js` (`sanitize`, `safeJoin`, `safeRealPath`), `multipart.js` (`parseMultipart`).

---

## Task 1: `WorkspaceStore` contract test

**Files:**
- Create: `sandbox-controller/stores/workspace-store.contract.js`
- Test: (driven by Task 2's `local-fs-store.test.js`)

**Interfaces:**
- Produces: `runWorkspaceStoreContract(makeStore)` — a function that, given a factory `() => ({ store, cleanup })`, registers a `describe` block asserting the `WorkspaceStore` behavior. `store` shape:
  `ensure(userId, sessionId) -> { wsHostPath, sharedHostPath }`,
  `list(userId, sessionId, path) -> FileEntry[]`,
  `read(userId, sessionId, path) -> ReadableStream`,
  `write(userId, sessionId, path, Buffer) -> void`,
  `size(userId, sessionId) -> number`,
  `remove(userId, sessionId) -> void`.

- [ ] **Step 1: Write the contract suite**

```js
// sandbox-controller/stores/workspace-store.contract.js
import { describe, it, expect, beforeEach, afterEach } from "vitest";

/** Shared behavioral contract every WorkspaceStore implementation must satisfy.
 *  @param {() => ({ store: any, cleanup: () => Promise<void> })} makeStore */
export function runWorkspaceStoreContract(makeStore) {
  describe("WorkspaceStore contract", () => {
    let store, cleanup;
    beforeEach(() => { ({ store, cleanup } = makeStore()); });
    afterEach(async () => { await cleanup?.(); });

    it("ensure() creates workspace + shared paths", async () => {
      const { wsHostPath, sharedHostPath } = await store.ensure("u1", "s1");
      expect(typeof wsHostPath).toBe("string");
      expect(typeof sharedHostPath).toBe("string");
      // idempotent
      await expect(store.ensure("u1", "s1")).resolves.toBeTruthy();
    });

    it("write() then read() round-trips bytes", async () => {
      await store.ensure("u1", "s1");
      await store.write("u1", "s1", "hello.txt", Buffer.from("hi"));
      const chunks = [];
      for await (const c of await store.read("u1", "s1", "hello.txt")) chunks.push(c);
      expect(Buffer.concat(chunks).toString()).toBe("hi");
    });

    it("list() returns written entries", async () => {
      await store.ensure("u1", "s1");
      await store.write("u1", "s1", "a.txt", Buffer.from("x"));
      const entries = await store.list("u1", "s1", ".");
      expect(entries.map((e) => e.name)).toContain("a.txt");
    });

    it("size() reflects written bytes", async () => {
      await store.ensure("u1", "s1");
      await store.write("u1", "s1", "a.bin", Buffer.alloc(100));
      expect(await store.size("u1", "s1")).toBeGreaterThanOrEqual(100);
    });

    it("remove() deletes the workspace", async () => {
      await store.ensure("u1", "s1");
      await store.write("u1", "s1", "a.txt", Buffer.from("x"));
      await store.remove("u1", "s1");
      await expect(store.list("u1", "s1", ".")).resolves.toEqual([]);
    });

    it("rejects path traversal", async () => {
      await store.ensure("u1", "s1");
      await expect(store.read("u1", "s1", "../../etc/passwd")).rejects.toBeTruthy();
    });

    it("isolates different sessions", async () => {
      await store.ensure("u1", "s1");
      await store.ensure("u1", "s2");
      await store.write("u1", "s1", "only-s1.txt", Buffer.from("x"));
      const s2 = await store.list("u1", "s2", ".");
      expect(s2.map((e) => e.name)).not.toContain("only-s1.txt");
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add sandbox-controller/stores/workspace-store.contract.js
git commit -m "test(sandbox): WorkspaceStore behavioral contract suite"
```

---

## Task 2: `LocalFsStore` (WorkspaceStore impl)

**Files:**
- Create: `sandbox-controller/stores/local-fs-store.js`
- Test: `sandbox-controller/stores/local-fs-store.test.js`

**Interfaces:**
- Consumes: `runWorkspaceStoreContract` (Task 1); `sanitize`, `safeRealPath`, `safeJoin` from `../path-safety.js`.
- Produces: `class LocalFsStore` with constructor `new LocalFsStore({ dataRoot, hostDataRoot?, uid, gid })` and the `WorkspaceStore` methods. Also exports `detectHostDataRoot(docker, { dataRoot, hostname, override })` (moved from `server.js`).

> The bodies of `ensure` (was `ensureMounts`), `list`/`read`/`write`/`size` (was the `/files`,`/download`,`/upload` handlers' fs parts and `dirSize`), and `detectHostDataRoot`/`toHostPath` are lifted from the current `sandbox-controller/server.js` (lines ~84–196, ~448–563). Preserve behavior exactly; only change the surface to the methods below.

- [ ] **Step 1: Write the failing test**

```js
// sandbox-controller/stores/local-fs-store.test.js
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsStore } from "./local-fs-store.js";
import { runWorkspaceStoreContract } from "./workspace-store.contract.js";

runWorkspaceStoreContract(() => {
  let dir;
  const init = async () => { dir = await mkdtemp(join(tmpdir(), "ws-")); };
  // vitest beforeEach in the contract calls makeStore() synchronously, so build
  // a temp dir lazily inside the store via a unique dataRoot per construction.
  dir = `${tmpdir()}/ws-${Math.random().toString(36).slice(2)}`;
  const store = new LocalFsStore({ dataRoot: dir, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 });
  return { store, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run sandbox-controller/stores/local-fs-store.test.js`
Expected: FAIL — `Cannot find module './local-fs-store.js'`.

- [ ] **Step 3: Implement `LocalFsStore`**

```js
// sandbox-controller/stores/local-fs-store.js
import { createReadStream } from "node:fs";
import { readdir, stat, mkdir, chown, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitize, safeRealPath } from "../path-safety.js";

/** WorkspaceStore backed by the local filesystem (Stage 1 default). */
export class LocalFsStore {
  constructor({ dataRoot, hostDataRoot, uid, gid }) {
    this.dataRoot = dataRoot;
    this.hostDataRoot = hostDataRoot || dataRoot; // see detectHostDataRoot()
    this.uid = uid;
    this.gid = gid;
  }

  #wsPath(userId, sessionId) {
    return resolve(this.dataRoot, sanitize(userId), sanitize(sessionId), "sandbox");
  }
  #sharedPath(userId) {
    return resolve(this.dataRoot, sanitize(userId), "_global", "sandbox");
  }
  /** Translate an internal storage path to the daemon-host path used for binds. */
  toHostPath(internalPath) {
    return internalPath.startsWith(this.dataRoot)
      ? this.hostDataRoot + internalPath.slice(this.dataRoot.length)
      : internalPath;
  }

  async ensure(userId, sessionId) {
    const wsPath = this.#wsPath(userId, sessionId);
    const sharedPath = this.#sharedPath(userId);
    await mkdir(wsPath, { recursive: true });
    await mkdir(sharedPath, { recursive: true });
    for (const dir of [wsPath, sharedPath]) {
      await chown(dir, this.uid, this.gid).catch((e) =>
        console.warn(`[mounts] chown ${dir} failed: ${e.message}`));
    }
    return { wsHostPath: this.toHostPath(wsPath), sharedHostPath: this.toHostPath(sharedPath) };
  }

  async list(userId, sessionId, relPath = ".") {
    const base = this.#wsPath(userId, sessionId);
    const dirPath = await safeRealPath(base, relPath);
    const names = await readdir(dirPath).catch(() => []);
    const entries = [];
    for (const name of names) {
      try {
        const s = await stat(join(dirPath, name));
        entries.push({
          name,
          path: relPath === "." ? name : `${relPath}/${name}`,
          isDirectory: s.isDirectory(),
          size: s.size,
          modifiedAt: s.mtime.toISOString(),
        });
      } catch { /* skip inaccessible */ }
    }
    return entries;
  }

  async read(userId, sessionId, relPath) {
    const base = this.#wsPath(userId, sessionId);
    const full = await safeRealPath(base, relPath);
    const s = await stat(full).catch(() => null);
    if (!s || s.isDirectory()) throw Object.assign(new Error("File not found"), { code: "ENOENT" });
    return createReadStream(full);
  }

  async write(userId, sessionId, relPath, data) {
    const base = this.#wsPath(userId, sessionId);
    const full = await safeRealPath(base, relPath);
    await mkdir(join(full, ".."), { recursive: true }).catch(() => {});
    await writeFile(full, data);
    await chown(full, this.uid, this.gid).catch(() => {});
  }

  async size(userId, sessionId) {
    const dirSize = async (dir) => {
      let total = 0;
      try {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          total += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size;
        }
      } catch { /* missing */ }
      return total;
    };
    return dirSize(this.#wsPath(userId, sessionId));
  }

  async remove(userId, sessionId) {
    await rm(this.#wsPath(userId, sessionId), { recursive: true, force: true });
  }
}

/** Resolve the daemon-host path backing dataRoot by inspecting our own container.
 *  Lifted from server.js; an explicit override wins. Returns the host path string. */
export async function detectHostDataRoot(docker, { dataRoot, hostname, override }) {
  if (override) return override;
  try {
    const self = await docker.getContainer(hostname).inspect();
    const backing = (self.Mounts || [])
      .filter((m) => m.Destination === dataRoot || dataRoot.startsWith(m.Destination + "/"))
      .sort((a, b) => b.Destination.length - a.Destination.length)[0];
    if (backing) return backing.Source + dataRoot.slice(backing.Destination.length);
  } catch (e) {
    console.warn(`[host-path] self-inspect failed (${e.message}); using ${dataRoot}`);
  }
  return dataRoot;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run sandbox-controller/stores/local-fs-store.test.js`
Expected: PASS (all contract cases).

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/stores/local-fs-store.js sandbox-controller/stores/local-fs-store.test.js
git commit -m "feat(sandbox): LocalFsStore behind WorkspaceStore port"
```

---

## Task 3: `WorkspaceStore` factory

**Files:**
- Create: `sandbox-controller/stores/workspace-factory.js`
- Test: `sandbox-controller/stores/workspace-factory.test.js`

**Interfaces:**
- Consumes: `LocalFsStore` (Task 2).
- Produces: `makeWorkspaceStore({ kind, dataRoot, hostDataRoot, uid, gid }) -> WorkspaceStore`. `kind` from `WORKSPACE_STORE` env; `"local"` → `LocalFsStore`; unknown → throw.

- [ ] **Step 1: Write the failing test**

```js
// sandbox-controller/stores/workspace-factory.test.js
import { describe, it, expect } from "vitest";
import { makeWorkspaceStore } from "./workspace-factory.js";
import { LocalFsStore } from "./local-fs-store.js";

describe("makeWorkspaceStore", () => {
  it("returns LocalFsStore for 'local'", () => {
    const s = makeWorkspaceStore({ kind: "local", dataRoot: "/tmp/x", uid: 1000, gid: 1000 });
    expect(s).toBeInstanceOf(LocalFsStore);
  });
  it("throws for unknown kind", () => {
    expect(() => makeWorkspaceStore({ kind: "s3", dataRoot: "/tmp/x" })).toThrow(/unknown.*store/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run sandbox-controller/stores/workspace-factory.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// sandbox-controller/stores/workspace-factory.js
import { LocalFsStore } from "./local-fs-store.js";

export function makeWorkspaceStore({ kind = "local", dataRoot, hostDataRoot, uid, gid }) {
  switch (kind) {
    case "local":
      return new LocalFsStore({ dataRoot, hostDataRoot, uid, gid });
    default:
      throw new Error(`unknown WORKSPACE_STORE: ${kind}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run sandbox-controller/stores/workspace-factory.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/stores/workspace-factory.js sandbox-controller/stores/workspace-factory.test.js
git commit -m "feat(sandbox): WorkspaceStore factory (WORKSPACE_STORE)"
```

---

## Task 4: Wire file endpoints in `server.js` to `WorkspaceStore`

**Files:**
- Modify: `sandbox-controller/server.js` (the `/files`, `/download`, `/upload` handlers + `ensureMounts` callers + `detectHostDataRoot` boot wiring)
- Test: `sandbox-controller/server-files.test.js`

**Interfaces:**
- Consumes: `makeWorkspaceStore` (Task 3), `detectHostDataRoot` (Task 2).
- Produces: a module-level `workspace` instance used by handlers; `resolveWsBase()` becomes ownership/HMAC validation only (returns `{ userId, sessionId }` or `{ forbidden|missing }`), with actual IO via `workspace.*`.

- [ ] **Step 1: Write the failing test** (handlers delegate to the store)

```js
// sandbox-controller/server-files.test.js
import { describe, it, expect, vi } from "vitest";
import { handleFiles } from "./server.js"; // exported for testing in Step 3

describe("handleFiles delegates to WorkspaceStore", () => {
  it("calls store.list with resolved owner", async () => {
    const store = { list: vi.fn().mockResolvedValue([{ name: "a.txt" }]) };
    const out = await handleFiles({ store, userId: "u1", sessionId: "s1", relPath: "." });
    expect(store.list).toHaveBeenCalledWith("u1", "s1", ".");
    expect(out).toEqual([{ name: "a.txt" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run sandbox-controller/server-files.test.js`
Expected: FAIL — `handleFiles` not exported.

- [ ] **Step 3: Refactor handlers to delegate + export the pure helper**

In `server.js`: construct `const workspace = makeWorkspaceStore({ kind: process.env.WORKSPACE_STORE || "local", dataRoot: DATA_ROOT, hostDataRoot, uid: SANDBOX_UID, gid: SANDBOX_GID })` at boot (after `detectHostDataRoot`). Replace the fs bodies inside the `/files`, `/download`, `/upload` route blocks with calls to `workspace.list/read/write/size`. Extract the post-auth IO of `/files` into an exported helper:

```js
// server.js (add near other helpers)
export async function handleFiles({ store, userId, sessionId, relPath }) {
  return store.list(userId, sessionId, relPath || ".");
}
```

Keep `resolveWsBase` for HMAC/ownership, but have it return `{ userId, sessionId }` and let handlers call `workspace.*`. `/download` streams `await workspace.read(...)` into the response; on `ENOENT` return the existing `404 { error: "File not found" }`. `/upload` quota check uses `await workspace.size(...)` then `workspace.write(...)`.

- [ ] **Step 4: Run tests to verify pass (no contract regressions)**

Run: `npx vitest run sandbox-controller/server-files.test.js && npx vitest run sandbox-controller/`
Expected: PASS; all 29 prior tests still green.

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/server.js sandbox-controller/server-files.test.js
git commit -m "refactor(sandbox): file endpoints go through WorkspaceStore"
```

---

## Task 5: gVisor runtime + hardening in `buildSandboxConfig`

**Files:**
- Modify: `sandbox-controller/sandbox-spec.js`
- Test: `sandbox-controller/sandbox-spec.test.js` (extend existing)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildSandboxConfig({ ...existing, runtime, pidsLimit, readonlyRootfs })` adds `HostConfig.Runtime`, `HostConfig.CapDrop=["ALL"]`, `HostConfig.SecurityOpt=["no-new-privileges"]`, `HostConfig.ReadonlyRootfs=true`, `HostConfig.Tmpfs={"/tmp":""}`, `HostConfig.PidsLimit`.

- [ ] **Step 1: Write the failing tests** (append to existing file)

```js
// sandbox-controller/sandbox-spec.test.js (append)
describe("buildSandboxConfig — isolation hardening", () => {
  it("sets the configured runtime", () => {
    const c = buildSandboxConfig({ ...base, runtime: "runsc" });
    expect(c.HostConfig.Runtime).toBe("runsc");
  });
  it("drops all caps and forbids privilege escalation", () => {
    const c = buildSandboxConfig({ ...base, runtime: "runsc" });
    expect(c.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(c.HostConfig.SecurityOpt).toContain("no-new-privileges");
  });
  it("read-only rootfs with writable /tmp tmpfs", () => {
    const c = buildSandboxConfig({ ...base, runtime: "runsc" });
    expect(c.HostConfig.ReadonlyRootfs).toBe(true);
    expect(c.HostConfig.Tmpfs).toHaveProperty("/tmp");
  });
  it("applies a pids limit", () => {
    const c = buildSandboxConfig({ ...base, runtime: "runsc", pidsLimit: 256 });
    expect(c.HostConfig.PidsLimit).toBe(256);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run sandbox-controller/sandbox-spec.test.js`
Expected: FAIL — new assertions fail (fields absent).

- [ ] **Step 3: Extend `buildSandboxConfig`** — add the fields to the returned `HostConfig` (default `pidsLimit = 512`, `runtime` passed through; `Tmpfs: { "/tmp": "rw,nosuid,nodev,size=64m" }`). Do not remove existing locked-posture fields the current tests assert.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run sandbox-controller/sandbox-spec.test.js`
Expected: PASS (old + new).

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/sandbox-spec.js sandbox-controller/sandbox-spec.test.js
git commit -m "feat(sandbox): gVisor runtime + hardening in sandbox spec"
```

---

## Task 6: Runtime fail-closed probe

**Files:**
- Create: `sandbox-controller/runtime-check.js`
- Test: `sandbox-controller/runtime-check.test.js`

**Interfaces:**
- Produces: `async function assertRuntimeAvailable(docker, { profile, runtime })` — resolves if `runtime==="runc"` or profile `dev`; for `secure`/`runsc`, inspects daemon `info.Runtimes` and throws (caller exits non-zero) if `runsc` is absent.

- [ ] **Step 1: Write the failing test**

```js
// sandbox-controller/runtime-check.test.js
import { describe, it, expect } from "vitest";
import { assertRuntimeAvailable } from "./runtime-check.js";

const dockerWith = (runtimes) => ({ info: async () => ({ Runtimes: runtimes }) });

describe("assertRuntimeAvailable", () => {
  it("passes when runsc is registered", async () => {
    await expect(assertRuntimeAvailable(dockerWith({ runc: {}, runsc: {} }), { profile: "secure", runtime: "runsc" })).resolves.toBeUndefined();
  });
  it("throws (fail-closed) when runsc missing in secure profile", async () => {
    await expect(assertRuntimeAvailable(dockerWith({ runc: {} }), { profile: "secure", runtime: "runsc" })).rejects.toThrow(/runsc/);
  });
  it("allows runc in dev profile", async () => {
    await expect(assertRuntimeAvailable(dockerWith({ runc: {} }), { profile: "dev", runtime: "runc" })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run sandbox-controller/runtime-check.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// sandbox-controller/runtime-check.js
/** Fail-closed: in the secure profile the configured gVisor runtime MUST exist
 *  on the daemon, else refuse to boot (never silently downgrade to runc). */
export async function assertRuntimeAvailable(docker, { profile, runtime }) {
  if (profile === "dev" || runtime === "runc") return;
  const info = await docker.info();
  if (!info?.Runtimes || !info.Runtimes[runtime]) {
    throw new Error(
      `FATAL: runtime "${runtime}" not registered on the Docker daemon.\n` +
      `  Secure profile requires gVisor. Install it (scripts/install-gvisor.sh)\n` +
      `  or set SANDBOX_RUNTIME=runc explicitly for a trusted/dev deploy.`,
    );
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run sandbox-controller/runtime-check.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/runtime-check.js sandbox-controller/runtime-check.test.js
git commit -m "feat(sandbox): fail-closed gVisor runtime probe"
```

---

## Task 7: `DockerBackend` + `ComputeBackend` contract

**Files:**
- Create: `sandbox-controller/backends/docker-backend.js`, `sandbox-controller/backends/compute-backend.contract.js`
- Test: `sandbox-controller/backends/docker-backend.test.js` (unit, mocked dockerode), `sandbox-controller/backends/docker-backend.integration.test.js` (real docker, skipped without `RUN_DOCKER_TESTS=1`)

**Interfaces:**
- Consumes: `dockerode`, `buildSandboxConfig`/`resolveNetworkMode` from `../sandbox-spec.js`.
- Produces: `class DockerBackend` with `new DockerBackend({ docker, image, runtime, defaults })`, methods `ensureRuntime()`, `create(spec)→{handle}`, `exec(handle,cmd,timeoutMs)→ExecResult`, `destroy(handle)`, `list()→RecoveredSandbox[]`. `list()` reads label `unclaw.session` and returns `{ sessionId, userId, handle, running }`. Plus `runComputeBackendContract(makeBackend)`.

> `create`/`exec`/`destroy`/`list` bodies are lifted from the current `createSandbox`/`execInSandbox`/`destroySandbox`/`recoverSessions` in `server.js` (lines ~200–360). `ensureRuntime` is new (Task 8 adds its tests; implement the method here, test it there).

- [ ] **Step 1: Write the contract suite (compute-backend.contract.js)**

```js
// sandbox-controller/backends/compute-backend.contract.js
import { describe, it, expect } from "vitest";
/** @param {() => any} makeBackend */
export function runComputeBackendContract(makeBackend) {
  describe("ComputeBackend contract", () => {
    it("create() returns a handle then list() finds the session", async () => {
      const b = makeBackend();
      const { handle } = await b.create({
        sessionId: "s1", userId: "u1", wsHostPath: "/tmp/ws", sharedHostPath: "/tmp/sh",
        networkMode: "none", memoryBytes: 384 * 1024 * 1024, nanoCpus: 1e9,
      });
      expect(handle).toBeTruthy();
      const found = (await b.list()).find((r) => r.sessionId === "s1");
      expect(found?.handle).toBe(handle);
      await b.destroy(handle);
    });
    it("exec() runs a command and returns exit code", async () => {
      const b = makeBackend();
      const { handle } = await b.create({
        sessionId: "s2", userId: "u1", wsHostPath: "/tmp/ws", sharedHostPath: "/tmp/sh",
        networkMode: "none", memoryBytes: 384 * 1024 * 1024, nanoCpus: 1e9,
      });
      const r = await b.exec(handle, "echo hi", 10000);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hi");
      await b.destroy(handle);
    });
  });
}
```

- [ ] **Step 2: Write the unit test (mocked) and run it (fails)**

```js
// sandbox-controller/backends/docker-backend.test.js
import { describe, it, expect, vi } from "vitest";
import { DockerBackend } from "./docker-backend.js";

describe("DockerBackend (mocked dockerode)", () => {
  it("create() builds a container with the configured runtime + labels", async () => {
    const start = vi.fn().mockResolvedValue();
    const createContainer = vi.fn().mockResolvedValue({ id: "c123", start });
    const docker = { createContainer };
    const b = new DockerBackend({ docker, image: "img:1", runtime: "runsc" });
    const { handle } = await b.create({
      sessionId: "s1", userId: "u1", wsHostPath: "/w", sharedHostPath: "/s",
      networkMode: "none", memoryBytes: 1, nanoCpus: 1,
    });
    expect(handle).toBe("c123");
    const cfg = createContainer.mock.calls[0][0];
    expect(cfg.HostConfig.Runtime).toBe("runsc");
    expect(cfg.Labels["unclaw.session"]).toBe("s1");
  });
});
```

Run: `npx vitest run sandbox-controller/backends/docker-backend.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `DockerBackend`** — port the four existing functions; ensure `create` passes `runtime` into `buildSandboxConfig` and sets `Labels: { "unclaw.session": sessionId, "unclaw.user": userId }`; `list()` maps `listContainers({all:true, filters:{label:["unclaw.session"]}})` to `RecoveredSandbox[]`. Include `async ensureRuntime()` (implemented in Task 8).

- [ ] **Step 4: Run unit test to pass**

Run: `npx vitest run sandbox-controller/backends/docker-backend.test.js`
Expected: PASS.

- [ ] **Step 5: Add the integration test (guarded) and commit**

```js
// sandbox-controller/backends/docker-backend.integration.test.js
import { describe } from "vitest";
import Docker from "dockerode";
import { DockerBackend } from "./docker-backend.js";
import { runComputeBackendContract } from "./compute-backend.contract.js";

const run = process.env.RUN_DOCKER_TESTS === "1";
(run ? describe : describe.skip)("DockerBackend integration", () => {
  runComputeBackendContract(() => new DockerBackend({
    docker: new Docker(), image: process.env.SANDBOX_IMAGE || "unclaw-sandbox",
    runtime: process.env.SANDBOX_RUNTIME || "runc",
  }));
});
```

```bash
git add sandbox-controller/backends/
git commit -m "feat(sandbox): DockerBackend behind ComputeBackend port + contract"
```

---

## Task 8: `ensureRuntime()` — pull-if-missing, dedup, atomic reset

**Files:**
- Modify: `sandbox-controller/backends/docker-backend.js`
- Test: `sandbox-controller/backends/docker-backend-ensure.test.js`

**Interfaces:**
- Produces: `DockerBackend.ensureRuntime()` — inspects the image; on 404 pulls and follows progress to completion; dedups concurrent calls via a single in-flight promise; resets the cached "ensured" flag atomically when a later `create` hits "No such image".

- [ ] **Step 1: Write the failing tests**

```js
// sandbox-controller/backends/docker-backend-ensure.test.js
import { describe, it, expect, vi } from "vitest";
import { DockerBackend } from "./docker-backend.js";

function makeDocker({ present }) {
  let exists = present;
  const followProgress = (s, cb) => cb(null, []);
  return {
    getImage: () => ({ inspect: async () => { if (!exists) { const e = new Error("no such image"); e.statusCode = 404; throw e; } return {}; } }),
    pull: vi.fn(async () => { exists = true; return {}; }),
    modem: { followProgress },
    _markPulled: () => { exists = true; },
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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run sandbox-controller/backends/docker-backend-ensure.test.js`
Expected: FAIL — `ensureRuntime` missing/`pull` not invoked.

- [ ] **Step 3: Implement `ensureRuntime` + integrate into `create`**

```js
// inside DockerBackend
async ensureRuntime() {
  if (this._ensured) return;
  if (this._ensuring) return this._ensuring;          // dedup concurrent
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
```

In `create`: call `await this.ensureRuntime()` first; wrap `createContainer` so that a `No such image` error does `this._ensured = false; await this.ensureRuntime();` once and retries (atomic via the same `_ensuring` guard), else rethrows with a clear message.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run sandbox-controller/backends/docker-backend-ensure.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/backends/docker-backend.js sandbox-controller/backends/docker-backend-ensure.test.js
git commit -m "feat(sandbox): ensureRuntime pull-if-missing with dedup + self-heal"
```

---

## Task 9: `backend` factory + add `pg` dependency

**Files:**
- Create: `sandbox-controller/backends/backend-factory.js`, `sandbox-controller/backends/backend-factory.test.js`
- Modify: `sandbox-controller/package.json` (add `"pg": "^8.20.0"`)

**Interfaces:**
- Produces: `makeComputeBackend({ kind, docker, image, runtime }) -> ComputeBackend`; `"docker"`→`DockerBackend`, unknown→throw.

- [ ] **Step 1: Write the failing test**

```js
// sandbox-controller/backends/backend-factory.test.js
import { describe, it, expect } from "vitest";
import { makeComputeBackend } from "./backend-factory.js";
import { DockerBackend } from "./docker-backend.js";

describe("makeComputeBackend", () => {
  it("returns DockerBackend for 'docker'", () => {
    expect(makeComputeBackend({ kind: "docker", docker: {}, image: "i", runtime: "runc" })).toBeInstanceOf(DockerBackend);
  });
  it("throws for unknown kind", () => {
    expect(() => makeComputeBackend({ kind: "k8s" })).toThrow(/unknown.*backend/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run sandbox-controller/backends/backend-factory.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement + add pg**

```js
// sandbox-controller/backends/backend-factory.js
import { DockerBackend } from "./docker-backend.js";
export function makeComputeBackend({ kind = "docker", docker, image, runtime }) {
  switch (kind) {
    case "docker": return new DockerBackend({ docker, image, runtime });
    default: throw new Error(`unknown COMPUTE_BACKEND: ${kind}`);
  }
}
```

Add `"pg": "^8.20.0"` to `sandbox-controller/package.json` `dependencies`, then:

Run: `cd sandbox-controller && npm install && cd ..` (regenerates lockfile)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run sandbox-controller/backends/backend-factory.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/backends/backend-factory.js sandbox-controller/backends/backend-factory.test.js sandbox-controller/package.json sandbox-controller/package-lock.json
git commit -m "feat(sandbox): ComputeBackend factory; add pg dependency"
```

---

## Task 10: `PostgresSessionStore` + in-process `lastActivity` cache

**Files:**
- Create: `sandbox-controller/session-store.js`, `sandbox-controller/session-store.test.js`

**Interfaces:**
- Consumes: `pg` (`Pool`).
- Produces: `class PostgresSessionStore` `new PostgresSessionStore({ pool })`; `init()` runs `CREATE TABLE IF NOT EXISTS sandbox_sessions (session_id text primary key, user_id text not null, handle text not null, network_mode text not null, last_activity bigint not null, created_at bigint not null)`; methods `upsert(rec)`, `get(id)`, `delete(id)`, `listByUser(uid)`, `all()`; `touch(id, ts)` updates an in-process cache; `flush()` writes cached `lastActivity` values to PG. The hot path calls `touch`, a periodic timer calls `flush`.

- [ ] **Step 1: Write the failing test** (guarded integration against a real PG via `TEST_DATABASE_URL`)

```js
// sandbox-controller/session-store.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { PostgresSessionStore } from "./session-store.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("PostgresSessionStore", () => {
  let pool, store;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    store = new PostgresSessionStore({ pool });
    await store.init();
    await pool.query("delete from sandbox_sessions");
  });
  afterAll(async () => { await pool.end(); });

  it("upsert/get round-trips and preserves networkMode", async () => {
    await store.upsert({ sessionId: "s1", userId: "u1", handle: "c1", networkMode: "none", lastActivity: 1, createdAt: 1 });
    const got = await store.get("s1");
    expect(got.networkMode).toBe("none");
    expect(got.handle).toBe("c1");
  });

  it("touch() + flush() persists lastActivity", async () => {
    store.touch("s1", 999);
    await store.flush();
    expect((await store.get("s1")).lastActivity).toBe(999);
  });

  it("delete() removes the record", async () => {
    await store.delete("s1");
    expect(await store.get("s1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run sandbox-controller/session-store.test.js`
Expected: FAIL — module not found (or SKIP if `TEST_DATABASE_URL` unset; set it to run: `TEST_DATABASE_URL=postgresql://unClaw:pw@localhost:5432/unClaw npx vitest run sandbox-controller/session-store.test.js`).

- [ ] **Step 3: Implement** the class with the `CREATE TABLE IF NOT EXISTS`, parameterized SQL for each method, an internal `Map` for `touch`, and `flush()` issuing one `UPDATE ... WHERE session_id = ANY(...)` (or per-key updates) from the cache then clearing it.

- [ ] **Step 4: Run to verify pass** (with `TEST_DATABASE_URL` set)

Run: `TEST_DATABASE_URL=... npx vitest run sandbox-controller/session-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/session-store.js sandbox-controller/session-store.test.js
git commit -m "feat(sandbox): PostgresSessionStore with in-process lastActivity cache"
```

---

## Task 11: Reconcile state machine + boot-gate

**Files:**
- Create: `sandbox-controller/reconcile.js`, `sandbox-controller/reconcile.test.js`

**Interfaces:**
- Consumes: a `SessionStore` and a `ComputeBackend` (duck-typed).
- Produces: `async function reconcile({ store, backend, destroy })` implementing the §14 table; returns `{ kept, removedRecords, destroyedOrphans }`. `destroy(handle)` defaults to `backend.destroy`.

- [ ] **Step 1: Write the failing test**

```js
// sandbox-controller/reconcile.test.js
import { describe, it, expect, vi } from "vitest";
import { reconcile } from "./reconcile.js";

function fakeStore(records) {
  const m = new Map(records.map((r) => [r.sessionId, r]));
  return { all: async () => [...m.values()], delete: async (id) => m.delete(id), _m: m };
}

describe("reconcile (§14 table)", () => {
  it("keeps running sessions present in both", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const backend = { list: async () => [{ sessionId: "s1", handle: "c1", running: true }], destroy: vi.fn() };
    const out = await reconcile({ store, backend });
    expect(out.kept).toContain("s1");
    expect(backend.destroy).not.toHaveBeenCalled();
  });
  it("deletes DB record with no backend container (zombie)", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const backend = { list: async () => [], destroy: vi.fn() };
    const out = await reconcile({ store, backend });
    expect(out.removedRecords).toContain("s1");
    expect(store._m.has("s1")).toBe(false);
  });
  it("destroys orphan container with no DB record", async () => {
    const store = fakeStore([]);
    const destroy = vi.fn();
    const backend = { list: async () => [{ sessionId: "s9", handle: "c9", running: true }], destroy };
    const out = await reconcile({ store, backend });
    expect(out.destroyedOrphans).toContain("s9");
    expect(destroy).toHaveBeenCalledWith("c9");
  });
  it("destroys + removes stopped container with a DB record", async () => {
    const store = fakeStore([{ sessionId: "s1", handle: "c1" }]);
    const destroy = vi.fn();
    const backend = { list: async () => [{ sessionId: "s1", handle: "c1", running: false }], destroy };
    const out = await reconcile({ store, backend });
    expect(destroy).toHaveBeenCalledWith("c1");
    expect(store._m.has("s1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run sandbox-controller/reconcile.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** the table: index `backend.list()` by `sessionId`; iterate DB records and backend entries applying each row of §14; `backend unreachable` (list throws) → rethrow so the caller leaves readiness false and retries.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run sandbox-controller/reconcile.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/reconcile.js sandbox-controller/reconcile.test.js
git commit -m "feat(sandbox): formal reconcile state machine"
```

---

## Task 12: Workspace GC

**Files:**
- Create: `sandbox-controller/gc.js`, `sandbox-controller/gc.test.js`

**Interfaces:**
- Consumes: a `SessionStore`, a `WorkspaceStore`, and a lister of on-disk `{ userId, sessionId }` workspaces.
- Produces: `async function gcOrphanWorkspaces({ store, workspace, listOnDisk, graceMs, now })` — removes workspaces whose `sessionId` is absent from `store.all()` and whose age exceeds `graceMs`.

- [ ] **Step 1: Write the failing test**

```js
// sandbox-controller/gc.test.js
import { describe, it, expect, vi } from "vitest";
import { gcOrphanWorkspaces } from "./gc.js";

describe("gcOrphanWorkspaces", () => {
  it("removes orphaned workspaces older than grace", async () => {
    const store = { all: async () => [{ sessionId: "live" }] };
    const remove = vi.fn();
    const workspace = { remove };
    const listOnDisk = async () => [
      { userId: "u1", sessionId: "live", mtimeMs: 0 },
      { userId: "u1", sessionId: "dead", mtimeMs: 0 },
    ];
    await gcOrphanWorkspaces({ store, workspace, listOnDisk, graceMs: 1000, now: 10_000 });
    expect(remove).toHaveBeenCalledWith("u1", "dead");
    expect(remove).not.toHaveBeenCalledWith("u1", "live");
  });
  it("keeps young orphans within grace", async () => {
    const store = { all: async () => [] };
    const remove = vi.fn();
    const listOnDisk = async () => [{ userId: "u1", sessionId: "new", mtimeMs: 9_500 }];
    await gcOrphanWorkspaces({ store, workspace: { remove }, listOnDisk, graceMs: 1000, now: 10_000 });
    expect(remove).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run sandbox-controller/gc.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — build a `Set` of live `sessionId`s; for each on-disk workspace not in the set with `now - mtimeMs > graceMs`, call `workspace.remove(userId, sessionId)`; log each removal.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run sandbox-controller/gc.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/gc.js sandbox-controller/gc.test.js
git commit -m "feat(sandbox): orphaned-workspace garbage collector"
```

---

## Task 13: Wire `server.js` — boot sequence, readiness, idle/eviction via ports

**Files:**
- Modify: `sandbox-controller/server.js`
- Test: `sandbox-controller/server-readiness.test.js`

**Interfaces:**
- Consumes: every module above.
- Produces: boot order `init pool → store.init() → detectHostDataRoot → assertRuntimeAvailable → ensureRuntime (prewarm) → reconcile → set ready=true → listen`; `/health` returns `{ ok, ready, sessions }`; while `!ready`, non-`/health` routes return `503`. Idle-cleanup, eviction, `POST /sessions`, `/exec`, `DELETE` use `backend` + `store` instead of the in-memory `Map`. A periodic timer calls `store.flush()` and `gcOrphanWorkspaces(...)`.

- [ ] **Step 1: Write the failing test**

```js
// sandbox-controller/server-readiness.test.js
import { describe, it, expect } from "vitest";
import { notReadyGuard } from "./server.js"; // exported in Step 3

describe("readiness gate", () => {
  it("blocks non-health routes until ready", () => {
    expect(notReadyGuard({ ready: false, path: "/sessions" })).toEqual({ block: true, status: 503 });
  });
  it("always allows /health", () => {
    expect(notReadyGuard({ ready: false, path: "/health" })).toEqual({ block: false });
  });
  it("allows routes once ready", () => {
    expect(notReadyGuard({ ready: true, path: "/sessions" })).toEqual({ block: false });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run sandbox-controller/server-readiness.test.js`
Expected: FAIL — `notReadyGuard` not exported.

- [ ] **Step 3: Refactor `server.js`** — add and export `notReadyGuard({ ready, path })`; call it in the request handler after `/health`. Replace the in-memory `sessions` `Map` reads/writes in `POST /sessions`, `/exec`, `DELETE /sessions/:id`, idle-cleanup, and eviction with `store` calls (`store.get/upsert/delete/listByUser`, `store.touch` on exec). Build `backend` via `makeComputeBackend` and `workspace` via `makeWorkspaceStore` at boot. Implement the boot sequence and the periodic `flush` + `gc` timer. Keep all HTTP response shapes identical.

- [ ] **Step 4: Run to verify pass (+ full suite, no regressions)**

Run: `npx vitest run sandbox-controller/server-readiness.test.js && npx vitest run sandbox-controller/`
Expected: PASS; whole controller suite green.

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/server.js sandbox-controller/server-readiness.test.js
git commit -m "refactor(sandbox): wire ports, durable sessions, readiness gate"
```

---

## Task 14: Structured logging + lifecycle audit

**Files:**
- Create: `sandbox-controller/log.js`, `sandbox-controller/log.test.js`
- Modify: `sandbox-controller/server.js`, `docker-backend.js` (emit lifecycle events)

**Interfaces:**
- Produces: `log(event, fields)` emitting one JSON line `{ ts, level, event, ...fields }`; lifecycle events `session.create|exec|destroy|evict|recover|gc` carry `sessionId`, `handle`, `image` where known (never command contents).

- [ ] **Step 1: Write the failing test**

```js
// sandbox-controller/log.test.js
import { describe, it, expect, vi } from "vitest";
import { log } from "./log.js";

describe("log", () => {
  it("emits one JSON line with event + fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("session.create", { sessionId: "s1", handle: "c1" });
    const line = JSON.parse(spy.mock.calls.at(-1)[0]);
    expect(line.event).toBe("session.create");
    expect(line.sessionId).toBe("s1");
    expect(typeof line.ts).toBe("string");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run sandbox-controller/log.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `log` and replace key `console.log/error` lifecycle lines in `server.js`/`docker-backend.js` with `log(...)` calls (create/exec/destroy/evict/recover/gc).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run sandbox-controller/log.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sandbox-controller/log.js sandbox-controller/log.test.js sandbox-controller/server.js sandbox-controller/backends/docker-backend.js
git commit -m "feat(sandbox): structured logging + lifecycle audit events"
```

---

## Task 15: Infra — socket-proxy, compose env, ghcr-pull, gVisor installer

**Files:**
- Modify: `docker-compose.yml`, `docker-compose.coolify.yml`
- Create: `scripts/install-gvisor.sh`
- Test: manual verification (documented commands)

**Interfaces:** none (deployment config).

- [ ] **Step 1: socket-proxy + controller env**

In both compose files: add `IMAGES=1` to the `socket-proxy` environment. Add to the `sandbox-controller` environment: `DATABASE_URL=postgresql://unClaw:${POSTGRES_PASSWORD}@postgres:5432/unClaw`, `COMPUTE_BACKEND=docker`, `WORKSPACE_STORE=local`, `SANDBOX_RUNTIME=${SANDBOX_RUNTIME:-runsc}`. Add `postgres: condition: service_healthy` to the controller `depends_on`. Set `SANDBOX_IMAGE` to the pinned ghcr reference (e.g. `ghcr.io/lyosu/unclaw-sandbox:${UNCLAW_VERSION}`); in `docker-compose.coolify.yml` drop the one-shot `sandbox` builder service and its `depends_on` (the controller now pulls via `ensureRuntime`).

- [ ] **Step 2: gVisor installer**

```bash
# scripts/install-gvisor.sh
#!/usr/bin/env sh
set -eu
# Install gVisor (runsc), register it as a Docker runtime, enable userns-remap.
ARCH="$(uname -m)"; URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"
wget -q "${URL}/runsc" "${URL}/runsc.sha512" "${URL}/containerd-shim-runsc-v1" "${URL}/containerd-shim-runsc-v1.sha512"
sha512sum -c runsc.sha512 -c containerd-shim-runsc-v1.sha512
chmod a+rx runsc containerd-shim-runsc-v1
mv runsc containerd-shim-runsc-v1 /usr/local/bin/
runsc install   # writes the runsc runtime into /etc/docker/daemon.json
# enable userns-remap (multi-tenant requirement) without clobbering existing keys
python3 - <<'PY'
import json,os
p="/etc/docker/daemon.json"; d=json.load(open(p)) if os.path.exists(p) else {}
d.setdefault("userns-remap","default")
json.dump(d,open(p,"w"),indent=2)
PY
echo "Installed. Restart docker:  systemctl restart docker"
```

- [ ] **Step 3: Verify (manual)**

Run on a host with Docker:
```bash
sh scripts/install-gvisor.sh && systemctl restart docker
docker info --format '{{json .Runtimes}}'   # expect: includes "runsc"
docker run --rm --runtime=runsc alpine uname -a   # boots under gVisor
```
Expected: `runsc` present; container runs.

- [ ] **Step 4: Verify prune self-heal (manual, on a deploy)**

```bash
docker rmi -f ghcr.io/lyosu/unclaw-sandbox:$UNCLAW_VERSION   # simulate Coolify prune
# trigger a new chat session via the platform; controller logs:
#   session.create after a transparent pull — no 404
```
Expected: session creates successfully after a transparent pull.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.coolify.yml scripts/install-gvisor.sh
git commit -m "chore(sandbox): IMAGES=1, controller DATABASE_URL/runtime env, ghcr-pull, gVisor installer"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §5 architecture → Tasks 7/9/2/3/13; §6.1 ComputeBackend → 7/8/9; §6.2 WorkspaceStore → 1/2/3/4; §8 isolation → 5/6/15; §9 perf/compat → deliverables are the integration test (7) + manual matrix (noted, run during 15 verification); §10 secrets model → enforced by 5 (no caps/env) + 15 (userns); §11 multi-tenancy limits → documented (no code this stage); §12 image lifecycle → 8/15; §13 session state → 10/13; §14 reconcile → 11/13; §15 GC → 12/13; §18 observability → 14; §19 health → 13; §20 migration → all; §21 testing → contract suites in 1/7, guarded integration in 7/10. Gap: the gVisor workload-compatibility *matrix* (§9.1) and benchmarks (§9.2) are manual deliverables, not automated tasks — run during Task 15 verification and record results in the spec's §9. The opaque `workspaceRef` refactor and `S3Store` are Stage 2 (out of scope), as is per-tenant secret/egress (§11 follow-up).

**Placeholder scan:** none — every code/test step carries runnable content; "lifted from server.js" steps name exact source functions/line ranges the engineer can open.

**Type consistency:** `WorkspaceStore` methods (`ensure/list/read/write/size/remove`) match across Tasks 1–4, 12, 13. `ComputeBackend` methods (`ensureRuntime/create/exec/destroy/list`) and `RecoveredSandbox` (`sessionId/handle/running`) match across 7, 8, 11, 13. `SessionRecord` fields match between 10 and 13. `notReadyGuard` shape matches between 13's test and usage.
