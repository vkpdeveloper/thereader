/**
 * Coordination between open tabs of the app. A tab that writes a stored key
 * tells the others to reload it; locks keep read-modify-write sequences and
 * sync requests to one tab at a time.
 */

export type Topic = 'settings' | 'library' | 'highlights' | 'sync' | 'imports';

export interface TabBus {
  post(topic: Topic): void;
  listen(handler: (topic: Topic) => void): () => void;
}

export interface Locks {
  /** Runs `fn` while holding `name`, waiting for other holders. */
  exclusive<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Runs `fn` only if `name` is free right now; otherwise resolves `undefined`. */
  tryExclusive<T>(name: string, fn: () => Promise<T>): Promise<T | undefined>;
}

export const noopBus: TabBus = { post() {}, listen: () => () => {} };

export function createBroadcastBus(name = 'thereader'): TabBus {
  if (typeof BroadcastChannel === 'undefined') return noopBus;
  const channel = new BroadcastChannel(name);
  const handlers = new Set<(topic: Topic) => void>();
  channel.onmessage = (event: MessageEvent) => {
    const topic = (event.data as { topic?: Topic } | null)?.topic;
    if (!topic) return;
    for (const handler of [...handlers]) handler(topic);
  };
  return {
    post(topic) {
      try {
        channel.postMessage({ topic });
      } catch {
        /* A closing tab cannot notify others; they reload on their next change. */
      }
    },
    listen(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

/** In-process locks: the fallback without Web Locks, and the test double. */
export function createMemoryLocks(): Locks {
  const tails = new Map<string, Promise<unknown>>();
  const held = new Set<string>();
  const exclusive = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(name) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      held.add(name);
      try {
        return await fn();
      } finally {
        held.delete(name);
      }
    });
    const tail = run.catch(() => undefined);
    tails.set(name, tail);
    void tail.then(() => {
      if (tails.get(name) === tail) tails.delete(name);
    });
    return run;
  };
  return {
    exclusive,
    async tryExclusive(name, fn) {
      if (held.has(name) || tails.has(name)) return undefined;
      return exclusive(name, fn);
    },
  };
}

export function createWebLocks(): Locks {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return createMemoryLocks();
  return {
    exclusive: (name, fn) => locks.request(name, { mode: 'exclusive' }, () => fn()),
    tryExclusive: <T>(name: string, fn: () => Promise<T>) =>
      locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) =>
        lock ? fn() : Promise.resolve(undefined),
      ) as Promise<T | undefined>,
  };
}
