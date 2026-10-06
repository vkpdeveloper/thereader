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
  articles?: unknown;
  [key: string]: unknown;
}

/** Saved-article documents, content-addressed by the SHA-256 of their JSON. */
export interface ArticleBodyApi {
  /** Uploads the exact JSON bytes (gzip-compressed when the browser can). Idempotent. */
  putArticleBody(sha256: string, json: Uint8Array): Promise<void>;
  /** The JSON bytes, decompressed. Not verified: callers check the hash. */
  getArticleBody(sha256: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface HttpApiClient extends ApiClient, ArticleBodyApi {
  /**
   * One pull+push. With `highlightsSince` (or `articlesSince`) the response
   * also carries highlight (article) rows changed since then; without them
   * the body is what older servers accept.
   */
  syncState(options: {
    deviceId: string;
    changes: Record<string, unknown>[];
    highlightsSince?: number;
    articlesSince?: number;
    keepalive?: boolean;
  }): Promise<SyncResponse>;
  /** Streams an EPUB. The caller reads `response.body`. */
  openDownload(book: Book, signal?: AbortSignal): Promise<Response>;
  /**
   * Streams bytes `[start, end)` of this exact edition (`If-Range` pinned to
   * its SHA-256) as `chunkSize` pieces aligned to `start`; the last piece may
   * be shorter and is delivered only once the whole range arrived. Ported
   * from mobile `ApiClient.streamRange`. A server that ignores ranges fails
   * with `INVALID_RANGE` and status 200; a short body with `TRUNCATED_RANGE`.
   */
  streamRange(
    book: Book,
    start: number,
    end: number,
    options: { onChunk: (chunk: Uint8Array) => void | Promise<void>; chunkSize?: number; signal?: AbortSignal },
  ): Promise<void>;
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
    async syncState({ deviceId, changes, highlightsSince, articlesSince, keepalive }) {
      const url = resolve('/v1/sync');
      const body = JSON.stringify({
        deviceId,
        changes,
        ...(highlightsSince === undefined ? {} : { highlightsSince }),
        ...(articlesSince === undefined ? {} : { articlesSince }),
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
    async putArticleBody(sha256, json) {
      const gzipped = await gzip(json);
      const response = await send(
        resolve(`/v1/article-bodies/${sha256}`),
        {
          method: 'PUT',
          headers: { 'content-type': gzipped ? 'application/gzip' : 'application/json', accept: 'application/json' },
          body: (gzipped ?? json) as BodyInit,
        },
        `Timed out uploading to ${host}.`,
      );
      const text = await readText(response, host);
      if (response.status !== 200 && response.status !== 201) throw errorFrom(response.status, text);
    },
    async getArticleBody(sha256, signal) {
      const url = resolve(`/v1/article-bodies/${sha256}`);
      const response = await send(url, { headers: { accept: 'application/gzip, application/json' } }, `Timed out connecting to ${host}.`, signal);
      if (response.status !== 200) throw errorFrom(response.status, await readText(response, host));
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        throw new ApiError(`The download from ${host} was interrupted.`, 'NETWORK', null, true);
      }
      const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (type !== 'application/gzip') return bytes;
      try {
        return await gunzip(bytes);
      } catch {
        throw new ApiError('The server returned a damaged article.', 'BAD_RESPONSE', response.status);
      }
    },
    async openDownload(book, signal) {
      const url = resolve(book.downloadUrl);
      const response = await send(url, { headers: { accept: 'application/epub+zip' } }, `Timed out connecting to ${host}.`, signal);
      if (response.status !== 200) throw errorFrom(response.status, await readText(response, host));
      return response;
    },
    async streamRange(book, start, end, { onChunk, chunkSize = 64 * 1024, signal }) {
      if (start < 0 || end <= start || end > book.fileSize || chunkSize <= 0) throw new RangeError('Invalid EPUB range');
      const url = resolve(book.downloadUrl);
      const etag = `"${book.sha256}"`;
      // One controller for headers and body, so an idle body can time out too.
      const request = new AbortController();
      const onAbort = () => request.abort();
      if (signal?.aborted) request.abort();
      signal?.addEventListener('abort', onAbort);
      let idle = false;
      try {
        // `send` maps connection failures and header timeouts to ApiError.
        const response = await send(
          url,
          { headers: { accept: 'application/epub+zip', range: `bytes=${start}-${end - 1}`, 'if-range': etag } },
          `Timed out connecting to ${host}.`,
          request.signal,
        );
        // Errors keep the server's message; retry decisions use the status.
        if (response.status >= 400) throw errorFrom(response.status, await readText(response, host));
        const length = response.headers.get('content-length');
        const encoding = response.headers.get('content-encoding');
        if (
          response.status !== 206 ||
          response.headers.get('content-range') !== `bytes ${start}-${end - 1}/${book.fileSize}` ||
          response.headers.get('etag') !== etag ||
          (length !== null && Number(length) !== end - start) ||
          (encoding !== null && encoding !== 'identity')
        ) {
          response.body?.cancel().catch(() => undefined);
          throw new ApiError(
            'The book changed or the server cannot stream this edition. Retry the download.',
            'INVALID_RANGE',
            response.status,
          );
        }
        if (!response.body) throw new ApiError('The book download was interrupted.', 'TRUNCATED_RANGE');
        const reader = response.body.getReader();
        let buffer = new Uint8Array(chunkSize);
        let filled = 0;
        let received = 0;
        try {
          for (;;) {
            const timer = setTimeout(() => {
              idle = true;
              request.abort();
            }, timeoutMs);
            let result: ReadableStreamReadResult<Uint8Array>;
            try {
              result = await reader.read();
            } catch (error) {
              if (idle) throw new ApiError('The book download timed out.', 'TIMEOUT', null, true);
              if (signal?.aborted) throw error;
              throw new ApiError(friendlyNetwork(error, url), 'NETWORK', null, true);
            } finally {
              clearTimeout(timer);
            }
            if (result.done) break;
            const incoming = result.value;
            if (received + incoming.length > end - start) {
              throw new ApiError('The server returned too many bytes.', 'INVALID_RANGE');
            }
            let offset = 0;
            while (offset < incoming.length) {
              const take = Math.min(incoming.length - offset, chunkSize - filled);
              buffer.set(incoming.subarray(offset, offset + take), filled);
              filled += take;
              received += take;
              offset += take;
              if (filled === chunkSize && received < end - start) {
                await onChunk(buffer);
                buffer = new Uint8Array(chunkSize);
                filled = 0;
              }
            }
          }
        } finally {
          reader.cancel().catch(() => undefined);
        }
        if (received !== end - start) throw new ApiError('The book download was interrupted.', 'TRUNCATED_RANGE');
        if (filled > 0) await onChunk(filled === chunkSize ? buffer : buffer.subarray(0, filled));
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
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

/** Gzip through the browser's native stream; null where it has none (sent as plain JSON). */
async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') return (await import('fflate')).gunzipSync(bytes);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
