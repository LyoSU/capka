import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    // Baseline hardening for every response. CSP is deliberately left out here —
    // it needs care around the inline theme-init script and is a separate task.
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // Quick Look frames the inline file download (e.g. PDFs) same-origin.
        // The blanket DENY above would block even our own iframe, so relax just
        // this response to SAMEORIGIN. Listed AFTER the catch-all so it wins
        // (Next applies the last matching header value).
        source: "/api/sandbox/files/download",
        has: [{ type: "query", key: "inline", value: "1" }],
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
