import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { Onest, Lora } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/sonner";
import { ServiceWorkerRegister } from "@/components/sw-register";
import "./globals.css";

// Body + UI face. Onest is a humanist sans drawn with Latin and Cyrillic as
// equal first-class scripts, so Ukrainian prose reads in a native typeface
// (not a fallback) and long AI answers stay comfortable. Replaces Geist Sans,
// whose grotesque, engineering character read as a developer tool. Geist Mono
// is kept for code; Lora carries the serif display headings.
const onest = Onest({
  subsets: ["latin", "cyrillic"],
  variable: "--font-onest",
  display: "swap",
});

// Serif display face for hero headings. Cyrillic subset is required — the UI is
// Ukrainian-first, and Latin-only display serifs (Instrument Serif, Fraunces)
// would fall back to a generic serif for Cyrillic text.
const lora = Lora({
  subsets: ["latin", "cyrillic"],
  variable: "--font-lora",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Capka",
  description: "Personal AI Platform",
  // iOS ignores the manifest's `display: standalone`; this is what makes the
  // app launch full-screen (no Safari chrome) once added to the home screen.
  // statusBarStyle "default" keeps content below the status bar — safe-area
  // insets are already handled, but this avoids any edge-to-edge surprises.
  appleWebApp: {
    capable: true,
    title: "Capka",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

// `viewportFit: "cover"` lets the app draw into the notch / home-indicator area
// so `env(safe-area-inset-*)` becomes non-zero — the chat composer and mobile
// headers pad themselves off those insets. themeColor moves here from manual
// <head> tags (Next dedupes it) to tint the mobile browser chrome per scheme.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f0ede8" },
    { media: "(prefers-color-scheme: dark)", color: "#1f1e1d" },
  ],
  viewportFit: "cover",
  // The on-screen keyboard shrinks the layout viewport (so `dvh` and a
  // bottom-pinned composer ride above it) on Chrome/Android. iOS ignores this,
  // so `useKeyboardInset` covers it there via the visualViewport API.
  interactiveWidget: "resizes-content",
};

// Applies the persisted (or system) theme to <html> BEFORE first paint, so a
// reload never flashes the wrong theme. Inlined in <head> rather than loaded as
// next/script `beforeInteractive`: in App Router that renders a literal <script>
// React refuses to execute on the client (and never re-runs across navigations),
// so the persisted theme was silently lost on reload. A raw inline script runs
// synchronously here, every load. (CSP is not set yet — see next.config.ts; when
// it is, this needs a hash/nonce.)
const THEME_INIT = `try{var t=localStorage.getItem("theme");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  return (
    <html
      lang={locale}
      className={`${onest.variable} ${GeistMono.variable} ${lora.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <link rel="manifest" href="/manifest.json" />
      </head>
      <body className="font-sans antialiased" suppressHydrationWarning>
        <NextIntlClientProvider>
          <Providers>
            {children}
            <Toaster />
            <ServiceWorkerRegister />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
