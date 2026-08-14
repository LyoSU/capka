import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * The integration suites CI can run with nothing but a Postgres service.
 *
 * This used to be a hand-written list of filenames inside the `test:integration:db` script,
 * which drifted the moment anyone added a suite: ten files matching the convention had
 * fallen out of it, including every test covering the plugin-install review — so those
 * invariants were green in CI because they never ran, not because they held.
 *
 * The rule is now the file-naming convention, stated once, with the exceptions named and
 * explained. Adding `foo.integration.test.ts` puts it in CI automatically.
 */
export default mergeConfig(base, defineConfig({
  test: {
    include: ["**/*.{integration,e2e}.test.{ts,js}"],
    exclude: [
      ...(base.test?.exclude ?? []),
      // Talks to the live OpenRouter/LiteLLM catalogs. A Postgres service does not make
      // this runnable, and putting the network on CI's critical path makes it flaky.
      "**/catalog.integration.test.ts",
      // Needs a running sandbox-controller and a Docker daemon.
      "**/sandbox/__tests__/workspaces.integration.test.ts",
      // Self-gated behind RUN_DOCKER_TESTS, so it would skip rather than fail — named here
      // anyway so its absence is a decision on record and not an accident of that gate.
      "**/docker-backend.integration.test.js",
    ],
    // These suites share one database. Running files in parallel lets one suite's fixtures
    // land in the middle of another's assertions.
    fileParallelism: false,
  },
}));
