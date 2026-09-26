import type { AppServices } from './contract';
import { createApiClient, type HttpApiClient } from './api';
import { CatalogStoreImpl } from './catalog';
import { CoverStoreImpl } from './covers';
import { HighlightStoreImpl } from './highlights';
import { createIdbKv } from './idb';
import { ImportStoreImpl } from './imports';
import { LibraryStoreImpl } from './library';
import { SettingsStoreImpl } from './settings';
import { StorageStoreImpl } from './storage';
import { SyncStoreImpl } from './sync';
import { createBroadcastBus, createWebLocks } from './tabs';

export * from './contract';
export { downloadFraction, isActive, isReady, normalizeOrigin } from './models';

const GLOBAL_KEY = '__thereaderServices';

/**
 * Composition root of the data layer. Call once (from main.tsx); later calls,
 * including after a hot reload, return the same instance so two sets of
 * stores never write the same IndexedDB keys.
 */
export function createServices(): AppServices {
  const holder = globalThis as typeof globalThis & { [GLOBAL_KEY]?: AppServices };
  return (holder[GLOBAL_KEY] ??= build());
}

function build(): AppServices {
  const kv = createIdbKv('kv');
  const books = createIdbKv('books');
  const coverKv = createIdbKv('covers');
  const bus = createBroadcastBus();
  const locks = createWebLocks();

  // The SPA is served by the API Worker (and Vite proxies /v1 in dev).
  const settings = new SettingsStoreImpl(kv, location.origin, bus);
  const currentOrigin = () => settings.currentOrigin();
  const clients = new Map<string, HttpApiClient>();
  const clientFor = (origin: string): HttpApiClient => {
    let client = clients.get(origin);
    if (!client) {
      client = createApiClient(origin);
      clients.set(origin, client);
    }
    return client;
  };

  let storage: StorageStoreImpl | null = null;
  const library = new LibraryStoreImpl({ kv, books, bus, currentOrigin, clientFor, onDownloaded: () => storage?.downloaded() });
  storage = new StorageStoreImpl(books, library);
  const catalog = new CatalogStoreImpl(currentOrigin, clientFor);
  const covers = new CoverStoreImpl(coverKv, (origin, path) => clientFor(origin).resolve(path));
  const highlights = new HighlightStoreImpl(kv, bus);
  // The import pipeline (zip parsing, MOBI conversion) loads on first use.
  const imports = new ImportStoreImpl({
    kv,
    books,
    library,
    currentOrigin,
    covers,
    bus,
    locks,
    inspect: async (file) => (await import('../import')).inspectFile(file),
    upload: async (options) => (await import('../import')).uploadBook(options),
  });
  const sync = new SyncStoreImpl({
    kv,
    library,
    settings,
    highlights,
    clientFor,
    isUploadPending: (id) => imports.isPending(id),
    retryUploads: () => void imports.retryPending(),
    bus,
    locks,
  });

  settings.subscribe(() => catalog.originChanged());
  imports.subscribe(() => sync.uploadsChanged());

  // One damaged store must not keep the others from loading.
  const step = (name: string, load: () => Promise<void>) =>
    load().catch((error) => console.error(`Could not load ${name}`, error));
  const ready = (async () => {
    await step('settings', () => settings.load());
    await step('library', () => library.load());
    await step('imports', () => imports.load());
    await step('highlights', () => highlights.load());
    await step('sync', () => sync.load());
  })();

  return { settings, catalog, library, highlights, sync, imports, covers, storage, ready };
}
