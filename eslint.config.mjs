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
    // Vendored helper scripts — their lint noise was drowning real signal.
    ".claude/**",
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
    },
  },
]);

export default eslintConfig;
