import { describe } from "vitest";
import Docker from "dockerode";
import { DockerBackend } from "./docker-backend.js";
import { runComputeBackendContract } from "./compute-backend.contract.js";

// Guarded: needs a real Docker daemon + a pullable/present sandbox image.
// Run locally (OrbStack incl. gVisor) with:
//   RUN_DOCKER_TESTS=1 SANDBOX_IMAGE=unclaw-sandbox SANDBOX_RUNTIME=runsc \
//     npx vitest run sandbox-controller/backends/docker-backend.integration.test.js
const run = process.env.RUN_DOCKER_TESTS === "1";

(run ? describe : describe.skip)("DockerBackend integration", () => {
  runComputeBackendContract(() => new DockerBackend({
    docker: new Docker(),
    image: process.env.SANDBOX_IMAGE || "unclaw-sandbox",
    runtime: process.env.SANDBOX_RUNTIME || "runc",
  }));
});
