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
    // `data/` holds user sandbox workspaces — code the AI wrote for users, not
    // our suite. Never let the runner descend into it (or build output).
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "data/**"],
  },
});
