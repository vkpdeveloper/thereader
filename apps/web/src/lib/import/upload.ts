import type { Book } from '../types';
import { ImportError, type UploadBook, type UploadProgress } from './contract';

/**
 * Port of `apps/mobile/lib/data/import/upload_api.dart` against
 * `apps/api/src/upload.ts`: prepare, then a single PUT (≤ 64 MiB) or
 * resumable 8 MiB multipart parts, then complete. PUTs use XMLHttpRequest
 * because fetch cannot report upload progress.
 */

const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const PREPARE_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const MAX_RESPONSE_CHARS = 256 * 1024;
const NETWORK_MESSAGE = 'Could not upload. Your book is saved on this device; retry when connected.';

interface MultipartUpload {
  uploadId: string;
  partSize: number;
  parts: Map<number, string>;
}

interface PreparedUpload {
  book: Book;
  uploaded: boolean;
  uploadUrl: string | null;
  multipart: MultipartUpload | null;
}

type Json = Record<string, unknown>;

function badResponse(message: string): ImportError {
  return new ImportError(message, 'BAD_RESPONSE');
}

function networkError(): ImportError {
  return new ImportError(NETWORK_MESSAGE, 'NETWORK', true);
}

function timeoutError(): ImportError {
  return new ImportError('Upload timed out. Your book is saved on this device.', 'TIMEOUT', true);
}

function abortedError(): ImportError {
  return new ImportError('The upload was cancelled.', 'ABORTED');
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const uploadBook: UploadBook = async ({ origin, book, epub, onProgress, signal }) => {
  const session = new UploadSession(origin, signal);
  if (signal?.aborted) throw abortedError();
  const prepared = await session.prepare(book);
  if (prepared.uploaded) return prepared.book;
  if (epub.size > book.fileSize) throw new ImportError('The local EPUB changed before upload.');
  if (epub.size < book.fileSize) throw new ImportError('The local EPUB is incomplete.');
  const report = (sent: number): void => onProgress?.({ sent, total: book.fileSize } satisfies UploadProgress);
  return prepared.multipart !== null
    ? session.uploadMultipart(book, prepared.multipart, epub, report)
    : session.upload(book, prepared.uploadUrl!, epub, report);
};

class UploadSession {
  private readonly base: URL;

  constructor(origin: string, private readonly signal: AbortSignal | undefined) {
    this.base = new URL(origin);
  }

  async prepare(book: Book): Promise<PreparedUpload> {
    const body = JSON.stringify({
      sha256: book.sha256,
      fileSize: book.fileSize,
      title: book.title,
      author: book.author,
      description: book.description,
      language: book.language,
      subjects: book.subjects,
    });
    const json = await this.postJson(new URL('/v1/uploads/prepare', this.base).href, body, PREPARE_TIMEOUT_MS);
    const canonical = parseBook(json, book);
    const uploaded = json.uploaded === true;
    const url = json.uploadUrl ?? null;
    if (url !== null && typeof url !== 'string') throw badResponse('The upload response is incomplete.');
    const multipart = isRecord(json.multipart) ? parseMultipart(json.multipart, book.fileSize) : null;
    if (!uploaded && (url === null) === (multipart === null)) throw badResponse('The upload response is incomplete.');
    if (url !== null) this.uploadUrl(url);
    return { book: canonical, uploaded, uploadUrl: url, multipart };
  }

  /** A catalog server cannot send private EPUB bytes to another origin or route. */
  private uploadUrl(url: string): string {
    let resolved: URL;
    try {
      resolved = new URL(url, this.base);
    } catch {
      throw badResponse('The server returned an invalid upload destination.');
    }
    if (
      resolved.origin !== this.base.origin ||
      resolved.username !== '' ||
      resolved.password !== '' ||
      !resolved.pathname.startsWith('/v1/uploads/')
    ) {
      throw badResponse('The server returned an invalid upload destination.');
    }
    return resolved.href;
  }

  async upload(book: Book, url: string, epub: Blob, onProgress: (sent: number) => void): Promise<Book> {
    const json = await this.put(
      this.uploadUrl(url),
      epub,
      { 'content-type': 'application/epub+zip' },
      (sent) => onProgress(Math.min(sent, book.fileSize)),
    );
    if (json.uploaded !== true) throw badResponse('The upload was not published.');
    onProgress(book.fileSize);
    return parseBook(json, book);
  }

  /** Re-prepare on retry lists acknowledged parts and resumes server-side state. */
  async uploadMultipart(book: Book, multipart: MultipartUpload, epub: Blob, onProgress: (sent: number) => void): Promise<Book> {
    const { partSize } = multipart;
    const count = Math.ceil(book.fileSize / partSize);
    const endOf = (number: number): number => Math.min(number * partSize, book.fileSize);
    let acknowledged = 0;
    for (const number of multipart.parts.keys()) acknowledged += endOf(number) - (number - 1) * partSize;
    onProgress(acknowledged);
    for (let number = 1; number <= count; number++) {
      if (this.signal?.aborted) throw abortedError();
      if (multipart.parts.has(number)) continue;
      const start = (number - 1) * partSize;
      const end = endOf(number);
      const response = await this.put(
        this.uploadUrl(`/v1/uploads/${book.sha256}/parts/${number}`),
        epub.slice(start, end),
        { 'content-type': 'application/octet-stream', 'x-upload-id': multipart.uploadId },
        (sent) => onProgress(acknowledged + Math.min(sent, end - start)),
      );
      const etag = response.etag;
      if (response.partNumber !== number || typeof etag !== 'string' || etag.length === 0 || etag.length > 1024) {
        throw badResponse('The server did not acknowledge the EPUB part.');
      }
      acknowledged += end - start;
      onProgress(acknowledged);
    }
    if (this.signal?.aborted) throw abortedError();
    const response = await this.postJson(
      this.uploadUrl(`/v1/uploads/${book.sha256}/complete`),
      JSON.stringify({ uploadId: multipart.uploadId }),
      TRANSFER_TIMEOUT_MS,
    );
    if (response.uploaded !== true) throw badResponse('The EPUB is uploaded but has not passed verification.');
    return parseBook(response, book);
  }

  private async postJson(url: string, body: string, timeoutMs: number): Promise<Json> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    this.signal?.addEventListener('abort', onAbort);
    try {
      let response: Response;
      let text: string;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          redirect: 'manual',
          cache: 'no-store',
          signal: controller.signal,
        });
        text = await response.text();
      } catch {
        if (this.signal?.aborted) throw abortedError();
        if (timedOut) throw timeoutError();
        throw networkError();
      }
      // `redirect: 'manual'` yields an opaque redirect: never follow it.
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw badResponse('The server redirected the upload, which is not allowed.');
      }
      return parseResponse(response.status, text);
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', onAbort);
    }
  }

  private put(url: string, body: Blob, headers: Record<string, string>, onProgress: (sent: number) => void): Promise<Json> {
    if (typeof XMLHttpRequest === 'undefined') return this.putWithFetch(url, body, headers, onProgress);
    return new Promise<Json>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const onAbort = (): void => xhr.abort();
      const settle = (): void => this.signal?.removeEventListener('abort', onAbort);
      xhr.open('PUT', url);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.timeout = TRANSFER_TIMEOUT_MS;
      xhr.responseType = 'text';
      xhr.upload.onprogress = (event) => onProgress(event.loaded);
      xhr.onload = () => {
        settle();
        try {
          // XHR follows redirects transparently; refuse any response that came from elsewhere.
          if (xhr.responseURL && xhr.responseURL !== url) {
            throw badResponse('The server redirected the upload, which is not allowed.');
          }
          resolve(parseResponse(xhr.status, xhr.responseText));
        } catch (error) {
          reject(error);
        }
      };
      xhr.onerror = () => {
        settle();
        reject(networkError());
      };
      xhr.ontimeout = () => {
        settle();
        reject(timeoutError());
      };
      xhr.onabort = () => {
        settle();
        reject(abortedError());
      };
      if (this.signal?.aborted) {
        reject(abortedError());
        return;
      }
      this.signal?.addEventListener('abort', onAbort);
      xhr.send(body);
    });
  }

  /** Environments without XHR (service workers): no incremental progress. */
  private async putWithFetch(url: string, body: Blob, headers: Record<string, string>, onProgress: (sent: number) => void): Promise<Json> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TRANSFER_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    this.signal?.addEventListener('abort', onAbort);
    try {
      let response: Response;
      let text: string;
      try {
        response = await fetch(url, { method: 'PUT', headers, body, redirect: 'manual', cache: 'no-store', signal: controller.signal });
        text = await response.text();
      } catch {
        if (this.signal?.aborted) throw abortedError();
        if (timedOut) throw timeoutError();
        throw networkError();
      }
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw badResponse('The server redirected the upload, which is not allowed.');
      }
      const json = parseResponse(response.status, text);
      onProgress(body.size);
      return json;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function parseResponse(status: number, text: string): Json {
  if (text.length > MAX_RESPONSE_CHARS) throw badResponse('The upload response is too large.');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (status !== 200 && status !== 201) {
    const error = isRecord(json) && isRecord(json.error) ? json.error : null;
    throw new ImportError(
      typeof error?.message === 'string' ? error.message : 'Upload failed.',
      typeof error?.code === 'string' ? error.code : 'UPLOAD_FAILED',
    );
  }
  if (!isRecord(json)) throw badResponse('The upload response is invalid.');
  return json;
}

function parseMultipart(json: Json, fileSize: number): MultipartUpload {
  const { uploadId: id, partSize: size, parts: listed } = json;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(id) ||
    size !== MULTIPART_PART_BYTES ||
    !Array.isArray(listed) ||
    listed.length > 64
  ) {
    throw badResponse('The multipart upload response is invalid.');
  }
  const count = Math.ceil(fileSize / size);
  const parts = new Map<number, string>();
  for (const raw of listed) {
    const number = isRecord(raw) ? raw.partNumber : null;
    const etag = isRecord(raw) ? raw.etag : null;
    if (
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > count ||
      parts.has(number) ||
      typeof etag !== 'string' ||
      etag.length === 0 ||
      etag.length > 1024
    ) {
      throw badResponse('The uploaded part list is invalid.');
    }
    parts.set(number, etag);
  }
  return { uploadId: id, partSize: size, parts };
}

/** `Book.fromJson` plus the check that the server describes this exact EPUB. */
function parseBook(json: Json, expected: Book): Book {
  const raw = json.book;
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    typeof raw.downloadUrl !== 'string' ||
    typeof raw.fileSize !== 'number' ||
    typeof raw.sha256 !== 'string'
  ) {
    throw badResponse('The upload response is invalid.');
  }
  const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);
  const updatedAt = typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))
    ? raw.updatedAt
    : new Date(0).toISOString();
  const book: Book = {
    id: raw.id,
    version: raw.version === undefined || raw.version === null ? '1' : String(raw.version),
    title: text(raw.title, 'Untitled'),
    author: text(raw.author, 'Unknown'),
    description: text(raw.description, ''),
    language: text(raw.language, 'en'),
    subjects: Array.isArray(raw.subjects) ? raw.subjects.map((subject) => String(subject)) : [],
    coverUrl: typeof raw.coverUrl === 'string' ? raw.coverUrl : null,
    downloadUrl: raw.downloadUrl,
    fileSize: Math.trunc(raw.fileSize),
    sha256: raw.sha256.toLowerCase(),
    updatedAt,
  };
  if (book.sha256 !== expected.sha256 || book.fileSize !== expected.fileSize) {
    throw badResponse('The upload response describes a different EPUB.');
  }
  return book;
}
