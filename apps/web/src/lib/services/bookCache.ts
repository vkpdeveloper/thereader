import type { Book } from '../types';
import type { KeyValueStore } from './kv';
import { isRecord, parseBook } from './models';
import { WriteQueue } from './observable';

/** Books remembered per origin, most recently fetched first. */
export const BOOK_CACHE_CAP = 100;

export const bookCacheKey = (origin: string): string => `book-cache.v1:${origin}`;

/**
 * Last-known copies of books fetched one at a time (deep links to /book/:id),
 * so a book page still opens offline.
 */
export class BookCache {
  private readonly writes = new WriteQueue();

  constructor(private readonly kv: KeyValueStore) {}

  remember(origin: string, book: Book): Promise<void> {
    return this.writes.run(async () => {
      const books = (await this.read(origin)).filter((b) => b.id !== book.id);
      await this.kv.set(bookCacheKey(origin), { origin, books: [book, ...books].slice(0, BOOK_CACHE_CAP) });
    });
  }

  async recall(origin: string, id: string): Promise<Book | null> {
    await this.writes.flush().catch(() => {});
    return (await this.read(origin)).find((b) => b.id === id) ?? null;
  }

  /** Damaged or foreign data reads as empty; single bad books are skipped. */
  private async read(origin: string): Promise<Book[]> {
    let value: unknown;
    try {
      value = await this.kv.get<unknown>(bookCacheKey(origin));
    } catch {
      return [];
    }
    if (!isRecord(value) || value.origin !== origin || !Array.isArray(value.books)) return [];
    const books: Book[] = [];
    for (const json of value.books) {
      try {
        books.push(parseBook(json));
      } catch {
        // skip
      }
    }
    return books;
  }
}
