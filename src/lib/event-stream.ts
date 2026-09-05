/**
 * One `/api/events` connection per tab, fanned out to every listener.
 *
 * The sidebar and the chat panel both want the user's task stream, and each used
 * to open its own EventSource with its own backoff. That is two Postgres LISTEN
 * subscriptions and two heartbeat timers held open per tab, for one stream of
 * events that both were filtering anyway.
 *
 * Ref-counted rather than opened once and left: a tab with no listener should
 * hold no server resources. Reconnect backoff lives here too, so a flapping
 * connection is retried once and not once per consumer.
 */

export type StreamListener = {
  /** One parsed event. Parsing happens once here, not per listener. */
  onMessage: (data: unknown) => void;
  /** Connected — the backoff has been reset. */
  onOpen?: () => void;
  /** Dropped; a reconnect is already scheduled. */
  onError?: () => void;
};

const listeners = new Set<StreamListener>();
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;

function connect() {
  retryTimer = null;
  source = new EventSource("/api/events");

  source.onopen = () => {
    retryDelay = 1000;
    for (const l of listeners) l.onOpen?.();
  };

  source.onmessage = (event) => {
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    for (const l of listeners) l.onMessage(data);
  };

  source.onerror = () => {
    for (const l of listeners) l.onError?.();
    source?.close();
    source = null;
    // Only rearm while someone is still listening: an error that lands during
    // the last unsubscribe would otherwise reconnect a stream nobody reads.
    if (listeners.size === 0) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  };
}

/** Subscribe; the returned function unsubscribes and closes the stream if it was
 *  the last listener. */
export function subscribeEvents(listener: StreamListener): () => void {
  listeners.add(listener);
  // `source` is null both before the first connect and during backoff, so the
  // armed timer is what separates "nothing is happening" from "a reconnect is
  // already on its way" — without it a new subscriber would open a second stream
  // alongside the pending retry.
  if (!source && !retryTimer) connect();
  // A listener that joins an already-open stream never sees an `open` event, and
  // the chat panel reads that as "SSE is down" — which turns its insurance poll
  // into a 3-second poll for the whole turn. Report the state it arrived into.
  else if (source?.readyState === EventSource.OPEN) listener.onOpen?.();

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryDelay = 1000;
    source?.close();
    source = null;
  };
}
