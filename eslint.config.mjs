import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored agent/tooling scratch dirs (not project source) — their lint noise
    // was drowning real signal and is not the project's to fix.
    ".claude/**",
    ".agents/**",
    ".impeccable/**",
    ".playwright-mcp/**",
    ".superpowers/**",
    ".cursor/**",
  ]),
  {
    // Open-core boundary: the AGPL core (src/**) must never import from ee/**.
    // EE features attach via extension points the core exposes, so the core
    // stays fully functional and shippable as open source on its own.
    files: ["src/**/*.{ts,tsx,js,jsx,mts}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/ee/*", "ee/*", "@/ee/*"],
          message: "The AGPL core (src/**) must not import from ee/** — keep the enterprise boundary clean.",
        }],
      }],
      // XSS gate: every raw-HTML sink must be a conscious, justified decision.
      // The two existing uses (static theme-init script; Shiki-escaped code) carry
      // an inline disable explaining why they're safe; any new one fails lint and
      // forces a review instead of silently shipping a sink for unsanitized input.
      "react/no-danger": "error",
    },
  },
]);

export default eslintConfig;
