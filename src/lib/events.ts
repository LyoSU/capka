type Listener = (data: unknown) => void;

class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(channel: string, listener: Listener): () => void {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
    this.listeners.get(channel)!.add(listener);
    return () => {
      this.listeners.get(channel)?.delete(listener);
    };
  }

  emit(channel: string, data: unknown) {
    this.listeners.get(channel)?.forEach((fn) => fn(data));
  }
}

// Attach to globalThis so the same instance survives Next.js module re-evaluation
const g = globalThis as unknown as { __eventBus?: EventBus };
export const eventBus = g.__eventBus ?? (g.__eventBus = new EventBus());
