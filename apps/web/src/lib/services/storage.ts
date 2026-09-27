import type { AppServices, StorageInfo, StorageStore } from './contract';
import type { KeyValueStore } from './kv';
import type { LibraryStoreImpl } from './library';
import { isReady } from './models';

/** Browser storage usage and the persistence grant that protects downloads from eviction. */
export class StorageStoreImpl implements StorageStore {
  private persistRequested = false;

  constructor(
    private readonly books: KeyValueStore,
    private readonly library: LibraryStoreImpl,
  ) {}

  async info(): Promise<StorageInfo> {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    const [estimate, persisted] = await Promise.all([
      storage?.estimate?.().catch(() => undefined),
      storage?.persisted?.().catch(() => false) ?? Promise.resolve(false),
    ]);
    const sizes = new Map<string, number>();
    for (const e of this.library.all) if (e.download.path) sizes.set(e.download.path, e.book.fileSize);
    let bookCount = 0;
    let bookBytes = 0;
    for (const key of await this.books.keys().catch(() => [] as string[])) {
      if (!key.startsWith('book:')) continue;
      bookCount++;
      const known = sizes.get(key);
      if (known !== undefined) bookBytes += known;
      else bookBytes += (await this.books.get<Blob>(key).catch(() => null))?.size ?? 0;
    }
    return {
      persisted: persisted === true,
      usageBytes: estimate?.usage ?? null,
      quotaBytes: estimate?.quota ?? null,
      bookCount,
      bookBytes,
    };
  }

  async requestPersistence(): Promise<boolean> {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage?.persist) return false;
    try {
      if (await storage.persisted?.()) return true;
      return await storage.persist();
    } catch {
      return false;
    }
  }

  /** After the first verified download, ask once per session to keep storage. */
  downloaded(): void {
    if (this.persistRequested) return;
    this.persistRequested = true;
    void this.requestPersistence();
  }
}

/**
 * At startup, once the library has loaded: ask the browser to keep storage
 * when there are downloads to protect or the app runs installed, so an
 * installed reader is protected before its first download. Silent and best effort.
 */
export async function persistAtStartup(services: Pick<AppServices, 'library' | 'storage'>): Promise<void> {
  if (!services.library.getSnapshot().entries.some((e) => isReady(e.download)) && !isInstalled()) return;
  await services.storage.requestPersistence().catch(() => false);
}

function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone || (window.matchMedia?.('(display-mode: standalone)').matches ?? false);
}
