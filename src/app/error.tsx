"use client"; // Error boundaries must be Client Components

import { ErrorState } from "@/components/shared/error-state";

/**
 * App-wide error boundary. Catches render errors in segments without a more
 * specific boundary (auth, setup, home). Renders inside the root layout, so
 * theme, fonts, and i18n are available. `unstable_retry` (Next 16.2+) re-fetches
 * and re-renders the failed segment; `reset` is kept as a fallback.
 */
export default function AppError({
  error,
  unstable_retry,
  reset,
}: {
  error: Error & { digest?: string };
  unstable_retry?: () => void;
  reset?: () => void;
}) {
  return <ErrorState error={error} retry={unstable_retry ?? reset} />;
}
