/**
 * Coalesces the SSE delta firehose into batched applies. The server already
 * batches text into ~100ms NOTIFYs (~10/s); on long replies each client render
 * costs O(full message length), so at the tail of a long answer per-token
 * rendering saturates a phone's main thread (taps and scroll go dead). Holding
 * deltas here and applying them in one burst halves-plus the render rate —
 * React 18 batches the whole burst into a single render — while still reading
 * as live typing.
 *
 * Only order-insensitive-dense events (text/reasoning deltas) should be
 * enqueued; apply everything else through `flush()` first so the part order
 * within the message is preserved.
 */
export function createDeltaCoalescer<E>(apply: (event: E) => void, intervalMs = 250) {
  let buf: E[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buf.length === 0) return;
    const batch = buf;
    buf = [];
    for (const e of batch) apply(e);
  };

  return {
    enqueue(event: E) {
      buf.push(event);
      timer ??= setTimeout(flush, intervalMs);
    },
    flush,
    /** Drop anything buffered without applying (unmount/chat switch). */
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      buf = [];
    },
  };
}
