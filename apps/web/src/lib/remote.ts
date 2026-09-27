import { BookCache } from './services/bookCache';
import { createIdbKv } from './services/idb';
import type { Book } from './types';

/**
 * The two direct API reads the UI needs that the service contract does not
 * cover: a health check for an address typed in Settings, and one book for a
 * deep link to /book/:id before the catalog has loaded.
 */

let bookCache: BookCache | null = null;
const books = () => (bookCache ??= new BookCache(createIdbKv('kv')));

const timeoutMs = 15_000;

async function getJson(url: string): Promise<Record<string, unknown>> {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new RemoteError(
      e instanceof DOMException && e.name === 'TimeoutError' ? `Timed out connecting to ${host}.` : `Could not reach ${host}.`,
      true,
    );
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // handled below
  }
  if (!response.ok) {
    const err = (json as { error?: { message?: string } } | null)?.error;
    throw new RemoteError(err?.message ?? `Request failed with HTTP ${response.status}.`, false, response.status);
  }
  if (!json || typeof json !== 'object') throw new RemoteError('The server returned an invalid response.', false);
  return json as Record<string, unknown>;
}

export class RemoteError extends Error {
  constructor(message: string, readonly isNetwork: boolean, readonly status: number | null = null) {
    super(message);
    this.name = 'RemoteError';
  }
}

export async function checkHealth(origin: string): Promise<{ ok: boolean; service: string }> {
  const json = await getJson(`${origin}/health`);
  return { ok: json.status === 'ok', service: String(json.service ?? 'unknown') };
}

/**
 * One book from the API, remembered per origin; when the API is unreachable
 * (or failing) the last fetched copy is returned instead.
 */
export async function fetchBook(origin: string, id: string): Promise<Book> {
  let book: Book | undefined;
  try {
    const json = await getJson(`${origin}/v1/books/${encodeURIComponent(id)}`);
    book = json.book as Book | undefined;
  } catch (error) {
    if (error instanceof RemoteError && (error.isNetwork || (error.status ?? 0) >= 500)) {
      const cached = await books().recall(origin, id).catch(() => null);
      if (cached) return cached;
    }
    throw error;
  }
  if (!book || typeof book.id !== 'string') throw new RemoteError('The server returned an invalid response.', false);
  void books().remember(origin, book).catch((error) => console.warn('Could not cache the book', error));
  return book;
}
