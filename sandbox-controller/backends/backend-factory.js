import { DockerBackend } from "./docker-backend.js";

/** Pick a ComputeBackend implementation by kind (COMPUTE_BACKEND env).
 *  Stage 1: only "docker". Later: "k8s", "managed". */
export function makeComputeBackend({ kind = "docker", docker, image, runtime }) {
  switch (kind) {
    case "docker":
      return new DockerBackend({ docker, image, runtime });
    default:
      throw new Error(`unknown COMPUTE_BACKEND: ${kind}`);
  }
}
