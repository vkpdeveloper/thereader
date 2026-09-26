/**
 * Async key-value storage. Production uses IndexedDB (see `idb.ts`); tests use
 * `MemoryKv`. Values are JSON-compatible data or Blobs.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export class MemoryKv implements KeyValueStore {
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    if (!this.data.has(key)) return null;
    return clone(this.data.get(key)) as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, clone(value));
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }
}

function clone(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  return JSON.parse(JSON.stringify(value));
}
