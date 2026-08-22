import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve the "@/..." path alias (mirrors tsconfig paths) so tests can import
// source modules the same way the app does.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Vitest's 5s default sits below the honest wall time of our slowest suites.
    // `sandbox-entrypoint.test.js` drives the egress firewall through `spawnSync`,
    // so its bodies BLOCK: the timeout timer cannot preempt a running child, and
    // whether it fires at all is a race with the event loop regaining control.
    // Measured on one full run: 11.8s PASSED while 8.3s FAILED in the same file,
    // with no assertion diff — and a suite that fails in CI but passes alone
    // teaches people to re-run instead of read, which is how a real failure
    // eventually gets waved through. Global rather than per-test: the blocking
    // shape makes a per-test timer the wrong lever, and the integration config
    // mergeConfig's this one, so both suites inherit the value from here.
    testTimeout: 20_000,
    // `data/` holds user sandbox workspaces — code the AI wrote for users, not
    // our suite. Never let the runner descend into it (or build output).
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "data/**"],
  },
});
