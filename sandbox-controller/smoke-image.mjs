#!/usr/bin/env node
/**
 * Runs the CAPABILITIES table against a sandbox image, in a container created by
 * the REAL DockerBackend.
 *
 * Why it goes through DockerBackend instead of a `docker run` line: the conditions
 * that matter here are the production container's, and the only authority on those
 * is buildSandboxConfig. A harness with its own hand-written --read-only /
 * --cap-drop flags is a second copy of that spec, free to drift from it — and a
 * drifted harness passes while production breaks, which is the exact failure this
 * suite exists to prevent. Calling create() means there is nothing to drift.
 *
 *   node sandbox-controller/smoke-image.mjs [image]   (default: capka-sandbox:latest)
 *
 * It lives in sandbox-controller/, not scripts/, because that package owns both
 * DockerBackend and the dockerode dependency — Node resolves a package import from
 * the importing FILE's tree, and the repo root has no dockerode.
 *
 * Exits non-zero on the first failing capability, printing what it got.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { DockerBackend } from "./backends/docker-backend.js";
import { CAPABILITIES, MUST_BE_ABSENT } from "../scripts/sandbox-capabilities.mjs";

const image = process.argv[2] || process.env.SANDBOX_IMAGE || "capka-sandbox:latest";
const sessionId = `smoke-${process.pid}`;

// The deployment knobs a default install runs with. Deliberately the DEFAULTS and
// not this machine's env: the suite should describe what a fresh deployment gets.
const spec = {
  sessionId,
  userId: "smoke",
  networkMode: "none",
  memoryBytes: 1024 * 1024 * 1024,
  nanoCpus: 2 * 1e9,
  pidsLimit: 256,
  tmpMb: 64,
  mcpTmpMb: 256,
  homeMb: 64,
  mcpUid: 1001,
  mcpGid: 1001,
  fsizeBytes: 0,
};

let failures = 0;
const done = new Set();
const root = mkdtempSync(join(tmpdir(), "capka-smoke-"));
const backend = new DockerBackend({
  docker: new Docker(),
  image,
  runtime: "runc",
  execTimeoutMs: 300_000,
});

function report(ok, name, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
    done.add(name);
  } else {
    failures++;
    console.log(`  FAIL ${name}\n       ${detail.replace(/\n/g, "\n       ")}`);
  }
}

let handle;
try {
  console.log(`sandbox smoke: ${image}`);
  // create() returns { handle }, not the id — passing the object straight into
  // exec() puts "[object Object]" in the request path.
  ({ handle } = await backend.create({ ...spec, wsHostPath: root, sharedHostPath: root }));

  // Prove the posture before trusting any result below: if the container is not
  // actually read-only with a writable HOME, every probe passes for the wrong
  // reason and the suite is decoration.
  const info = await new Docker().getContainer(handle).inspect();
  const posture = {
    readonlyRootfs: info.HostConfig.ReadonlyRootfs === true,
    capsDropped: (info.HostConfig.CapDrop || []).includes("ALL"),
    noNewPrivileges: (info.HostConfig.SecurityOpt || []).includes("no-new-privileges"),
    homeTmpfs: Boolean((info.HostConfig.Tmpfs || {})["/home/sandbox"]),
  };
  console.log("posture:", JSON.stringify(posture));
  for (const [k, v] of Object.entries(posture)) {
    if (!v) {
      console.error(`\nsandbox smoke: refusing to run — the container is not in the production posture (${k} is false).`);
      process.exit(2);
    }
  }

  console.log("\nwrappers that must be absent:");
  for (const { module, unless, why } of MUST_BE_ABSENT) {
    const r = await backend.exec(handle, `command -v ${unless} >/dev/null && echo present || echo absent`);
    const wrapped = r.stdout.trim() === "present";
    const imported = await backend.exec(handle, `python3 -c "import ${module}" 2>/dev/null && echo yes || echo no`);
    const installed = imported.stdout.trim() === "yes";
    report(
      wrapped || !installed,
      `${module} not installed without ${unless}`,
      `${module} imports but ${unless} is absent — ${why}`,
    );
  }

  console.log("\ncapabilities:");
  for (const probe of CAPABILITIES) {
    if (probe.needs && !done.has(probe.needs)) {
      console.log(`  skip ${probe.name} (depends on "${probe.needs}", which failed)`);
      continue;
    }
    const r = await backend.exec(handle, `cd /workspace && ${probe.cmd}`);
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    report(probe.want.test(out), probe.name, `exit ${r.exitCode}; output: ${out.trim().slice(0, 300) || "(empty)"}`);
  }
} finally {
  if (handle) await backend.destroy(handle).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failing` : "\nall capabilities present");
process.exit(failures ? 1 : 0);
