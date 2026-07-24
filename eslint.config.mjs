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
    // Runtime user-sandbox data (bind-mounted workspaces) — not project source;
    // it holds arbitrary user/agent code and must never gate the project's lint.
    "data/**",
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
  {
    // STAGED ADOPTION — React Compiler readiness rules, deliberately not yet gating.
    //
    // eslint-plugin-react-hooks (via eslint-config-next 16.2.11) added this rule
    // family. It flags 33 PRE-EXISTING findings across 23 files — none introduced by
    // the change that pinned this block, and none an active bug: the two
    // `immutability` hits are idiomatic `window.location.href` navigations, and
    // `purity` is a `Date.now()` read during render (a stale badge at worst).
    //
    // They are NOT waived. Every real fix here changes render timing — deriving
    // state during render instead of in an effect, moving ref reads out of render —
    // so it needs its own pass with browser verification of the affected dialogs,
    // pickers, and the composer, not a blind sweep folded into an unrelated commit.
    // Left at "off" rather than reverting eslint-config-next so the toolchain stays
    // current and the debt is greppable in exactly one place. Re-enable per rule as
    // each is cleared; `set-state-in-effect` (23) and `refs` (7) are the bulk.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
    },
  },
]);

export default eslintConfig;
