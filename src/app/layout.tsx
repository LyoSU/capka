import type { Metadata } from "next";
import Script from "next/script";
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
  title: "unClaw",
  description: "Personal AI Platform",
  icons: {
    icon: [
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

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
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#f0ede8" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#1f1e1d" media="(prefers-color-scheme: dark)" />
      </head>
      <body className="font-sans antialiased" suppressHydrationWarning>
        <Script src="/theme-init.js" strategy="beforeInteractive" />
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
