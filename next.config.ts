import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// The safe, inline-agnostic slice of a CSP: it constrains attack surface that the
// app simply never uses, so it can't break anything. `object-src 'none'` kills
// plugin/embed execution; `base-uri 'self'` blocks <base>-tag injection from
// re-pointing relative URLs; `form-action 'self'` stops a form from being
// hijacked to POST credentials cross-origin. A strict `script-src`/`style-src`
// (no 'unsafe-inline') is intentionally NOT here — it needs a per-request nonce
// threaded through middleware for the inline theme-init script AND Next's own
// hydration scripts, plus live-browser testing. That remains a separate task.
const BASE_CSP = "object-src 'none'; base-uri 'self'; form-action 'self'";

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // frame-ancestors is the modern, header-superseding clickjacking guard;
          // 'none' mirrors the DENY above for browsers that honour CSP.
          { key: "Content-Security-Policy", value: `${BASE_CSP}; frame-ancestors 'none'` },
        ],
      },
      {
        // Quick Look frames the inline file download (e.g. PDFs) same-origin.
        // The blanket DENY above would block even our own iframe, so relax just
        // this response to SAMEORIGIN. Listed AFTER the catch-all so it wins
        // (Next applies the last matching header value) — and the CSP override
        // must come too, or the catch-all's frame-ancestors 'none' still blocks it.
        source: "/api/sandbox/files/download",
        has: [{ type: "query", key: "inline", value: "1" }],
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: `${BASE_CSP}; frame-ancestors 'self'` },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
