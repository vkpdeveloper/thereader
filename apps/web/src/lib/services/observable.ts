import type { Observable } from './contract';

/**
 * Minimal observable used by every store. Methods are bound properties so
 * `useSyncExternalStore(store.subscribe, store.getSnapshot)` works unbound.
 */
export class Emitter<T> implements Observable<T> {
  private readonly listeners = new Set<() => void>();

  constructor(protected snapshot: T) {}

  getSnapshot = (): T => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  protected emit(next: T): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error(error);
      }
    }
  }
}

/** Serializes async writes so a slower old write never replaces a newer one. */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();

  run(write: () => Promise<void>, onError?: (error: unknown) => void): Promise<void> {
    const next = this.tail.then(write);
    this.tail = next.catch((error) => {
      if (onError) onError(error);
      else console.warn('Persistence failed', error);
    });
    return next;
  }

  flush(): Promise<void> {
    return this.tail;
  }
}
