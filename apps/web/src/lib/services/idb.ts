import localforage from 'localforage';
import type { KeyValueStore } from './kv';

/**
 * IndexedDB-backed key-value store (one object store per concern in the
 * `thereader` database). Blobs are stored natively, so downloaded EPUBs and
 * covers survive reloads and work offline.
 */
export function createIdbKv(storeName: 'kv' | 'books' | 'covers'): KeyValueStore {
  const store = localforage.createInstance({
    name: 'thereader',
    storeName,
    driver: [localforage.INDEXEDDB, localforage.LOCALSTORAGE],
  });
  return {
    get: <T>(key: string) => store.getItem<T>(key),
    set: async (key, value) => {
      await store.setItem(key, value);
    },
    remove: (key) => store.removeItem(key),
    keys: () => store.keys(),
  };
}
