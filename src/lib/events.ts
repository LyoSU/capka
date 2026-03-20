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

export const eventBus = new EventBus();
