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
