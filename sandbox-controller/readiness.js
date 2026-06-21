/** Boot-gate: until reconcile finishes, the controller serves /health (so the
 *  orchestrator can probe liveness) but returns 503 for every other route. */
export function notReadyGuard({ ready, path }) {
  if (path === "/health") return { block: false };
  if (!ready) return { block: true, status: 503 };
  return { block: false };
}
