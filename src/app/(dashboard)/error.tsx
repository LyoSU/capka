"use client"; // Error boundaries must be Client Components

import { ErrorState } from "@/components/shared/error-state";

/**
 * Dashboard error boundary. Because `error.tsx` does not wrap its own segment's
 * `layout.tsx`, this renders inside the sidebar shell — navigation stays live so
 * the user can click away from the broken page.
 */
export default function DashboardError({
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
