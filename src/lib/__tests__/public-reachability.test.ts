import { describe, it, expect, vi } from "vitest";

// `@/lib/setup` is server-only (next/headers → auth → db). The function under test
// is pure and takes its env explicitly, so stub the module's other imports rather
// than moving it somewhere client-safe — where a bundled `process.env` would make
// it silently answer "not reachable".
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => null } }) }));
vi.mock("@/lib/settings", () => ({ getSetting: async () => null, isSetupComplete: async () => false }));

import { isPubliclyReachable } from "@/lib/setup";

describe("isPubliclyReachable — who may claim admin on first run", () => {
  it("treats an absent PLATFORM_BIND as local (bare npm run dev)", () => {
    // Compose ALWAYS passes the variable, so absent means no compose.
    expect(isPubliclyReachable({})).toBe(false);
  });

  it("treats compose's default bind as reachable", () => {
    // docker-compose.yml maps ${PLATFORM_BIND:-0.0.0.0}, so this is the DEFAULT
    // deploy — the admin-claim race is the default, not an exotic setup.
    expect(isPubliclyReachable({ PLATFORM_BIND: "0.0.0.0" })).toBe(true);
  });

  it("treats an explicit loopback bind as local", () => {
    expect(isPubliclyReachable({ PLATFORM_BIND: "127.0.0.1" })).toBe(false);
    expect(isPubliclyReachable({ PLATFORM_BIND: "localhost" })).toBe(false);
    expect(isPubliclyReachable({ PLATFORM_BIND: "::1" })).toBe(false);
  });

  it("treats a non-local PUBLIC_URL as reachable even on a loopback bind", () => {
    // The normal reverse-proxy shape: the container binds loopback, the proxy
    // publishes it. That is still a public bootstrap window.
    expect(isPubliclyReachable({ PLATFORM_BIND: "127.0.0.1", PUBLIC_URL: "https://capka.example" })).toBe(true);
  });

  it("honors the deprecated BETTER_AUTH_URL alias", () => {
    expect(isPubliclyReachable({ BETTER_AUTH_URL: "https://capka.example" })).toBe(true);
  });

  it("keeps a localhost PUBLIC_URL local", () => {
    expect(isPubliclyReachable({ PUBLIC_URL: "http://localhost:3000" })).toBe(false);
    expect(isPubliclyReachable({ PUBLIC_URL: "http://127.0.0.1:3000" })).toBe(false);
    expect(isPubliclyReachable({ PUBLIC_URL: "http://[::1]:3000" })).toBe(false);
  });

  it("fails closed on an unparseable PUBLIC_URL", () => {
    // A typo in the override must not silently unlock the bootstrap.
    expect(isPubliclyReachable({ PUBLIC_URL: "not a url" })).toBe(true);
  });

  it("lets the bind decide when PUBLIC_URL is local but the port is published", () => {
    expect(isPubliclyReachable({ PUBLIC_URL: "http://localhost:3000", PLATFORM_BIND: "0.0.0.0" })).toBe(true);
  });
});
