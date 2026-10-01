"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      // Registration can reject (unsupported context, a blocked or failing /sw.js);
      // the app works without the worker, so a rejection must not surface as an
      // unhandled error.
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
