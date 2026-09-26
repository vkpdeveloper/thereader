import type { Book } from '../types';
import { ApiError, type ApiClient } from './contract';
import { isRecord, normalizeOrigin, parseBook } from './models';

/**
 * Thin HTTP client for the reader API, ported from mobile `ApiClient`: no
 * auth, 15 s timeouts, friendly network errors and `{error: {code, message}}`
 * parsing.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SyncResponse {
  serverTime?: string;
  books: unknown[];
  preferences: unknown;
  highlights?: unknown;
  [key: string]: unknown;
}

export interface HttpApiClient extends ApiClient {
  /**
   * One pull+push. With `highlightsSince` the response also carries highlight
   * rows changed since then; without it the body is what older servers accept.
   */
  syncState(options: {
    deviceId: string;
    changes: Record<string, unknown>[];
    highlightsSince?: number;
    keepalive?: boolean;
  }): Promise<SyncResponse>;
  /** Streams an EPUB. The caller reads `response.body`. */
  openDownload(book: Book, signal?: AbortSignal): Promise<Response>;
}

export const API_TIMEOUT_MS = 15_000;
/** Browsers cap keepalive bodies at 64 KiB in total. */
export const KEEPALIVE_LIMIT = 60 * 1024;

export function createApiClient(
  base: string,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): HttpApiClient {
  const origin = normalizeOrigin(base);
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;
  const host = new URL(origin).host;

  const resolve = (pathOrUrl: string): string => new URL(pathOrUrl, `${origin}/`).toString();

  /** Fetch with a timeout that covers the response headers. */
  async function send(
    url: string,
    init: RequestInit,
    timeoutMessage: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new ApiError(timeoutMessage, 'TIMEOUT', null, true);
      if (signal?.aborted) throw error;
      throw new ApiError(friendlyNetwork(error, url), 'NETWORK', null, true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function getJson(url: string): Promise<Record<string, unknown>> {
    const response = await send(url, { headers: { accept: 'application/json' } }, `Timed out connecting to ${host}.`);
    const body = await readText(response, host);
    if (response.status !== 200) throw errorFrom(response.status, body);
    try {
      const json = JSON.parse(body) as unknown;
      if (!isRecord(json)) throw new Error();
      return json;
    } catch {
      throw new ApiError('The server returned something that is not JSON.', 'BAD_RESPONSE', response.status);
    }
  }

  function bookFrom(value: unknown): Book {
    try {
      return parseBook(value);
    } catch {
      throw new ApiError('The server returned an invalid book.', 'BAD_RESPONSE');
    }
  }

  return {
    origin,
    resolve,
    async health() {
      const json = await getJson(resolve('/health'));
      return { ok: json.status === 'ok', service: json.service === undefined ? 'unknown' : String(json.service) };
    },
    async listBooks({ limit = 24, cursor, query }) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set('cursor', cursor);
      if (query && query.trim()) params.set('q', query.trim());
      const json = await getJson(`${resolve('/v1/books')}?${params}`);
      const items = Array.isArray(json.items) ? json.items.map(bookFrom) : [];
      return { items, nextCursor: typeof json.nextCursor === 'string' ? json.nextCursor : null };
    },
    async getBook(id) {
      const json = await getJson(resolve(`/v1/books/${encodeURIComponent(id)}`));
      return bookFrom(json.book);
    },
    async syncState({ deviceId, changes, highlightsSince, keepalive }) {
      const url = resolve('/v1/sync');
      const body = JSON.stringify({
        deviceId,
        changes,
        ...(highlightsSince === undefined ? {} : { highlightsSince }),
      });
      const response = await send(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body,
          keepalive: keepalive === true && new TextEncoder().encode(body).length < KEEPALIVE_LIMIT,
        },
        'Sync timed out. Changes are saved on this device.',
      );
      const text = await readText(response, host);
      if (response.status !== 200) throw errorFrom(response.status, text);
      try {
        const json = JSON.parse(text) as unknown;
        if (!isRecord(json) || !Array.isArray(json.books)) throw new Error();
        return json as SyncResponse;
      } catch {
        throw new ApiError('The server returned an invalid sync response.', 'BAD_RESPONSE');
      }
    },
    async openDownload(book, signal) {
      const url = resolve(book.downloadUrl);
      const response = await send(url, { headers: { accept: 'application/epub+zip' } }, `Timed out connecting to ${host}.`, signal);
      if (response.status !== 200) throw errorFrom(response.status, await readText(response, host));
      return response;
    },
  };
}

async function readText(response: Response, host: string): Promise<string> {
  try {
    return await response.text();
  } catch {
    throw new ApiError(`Could not reach ${host}.`, 'NETWORK', response.status, true);
  }
}

function friendlyNetwork(error: unknown, url: string): string {
  const host = new URL(url).host;
  const lower = String((error as Error | undefined)?.message ?? error).toLowerCase();
  if (lower.includes('refused')) return `Nothing is listening at ${host}.`;
  if (lower.includes('name not resolved') || lower.includes('host lookup')) return `Could not find ${new URL(url).hostname}.`;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return `You are offline. Could not reach ${host}.`;
  return `Could not reach ${host}.`;
}

export function errorFrom(status: number, body: string): ApiError {
  try {
    const json = JSON.parse(body) as unknown;
    const err = isRecord(json) && isRecord(json.error) ? json.error : null;
    if (err) {
      return new ApiError(
        err.message === undefined ? 'Request failed.' : String(err.message),
        err.code === undefined ? `HTTP_${status}` : String(err.code),
        status,
      );
    }
  } catch {
    /* Not JSON. */
  }
  return new ApiError(`Request failed with HTTP ${status}.`, `HTTP_${status}`, status);
}

/** Message of any thrown value, preferring ApiError's user-facing text. */
export function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}
