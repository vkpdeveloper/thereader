import { ApiError } from "./errors";
import type { CatalogBook, Env } from "./types";

interface ByteRange {
  offset: number;
  length: number;
  end: number;
}

function parseRange(value: string, size: number): ByteRange {
  if (!value.startsWith("bytes=") || value.includes(",")) {
    throw rangeError(size);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null) throw rangeError(size);
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") throw rangeError(size);

  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw rangeError(size);
    const length = Math.min(suffix, size);
    return { offset: size - length, length, end: size - 1 };
  }

  const offset = Number(startText);
  if (!Number.isSafeInteger(offset) || offset >= size) throw rangeError(size);
  const requestedEnd = endText === "" ? size - 1 : Number(endText);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < offset) throw rangeError(size);
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1, end };
}

function rangeError(size: number): ApiError {
  return new ApiError(416, "RANGE_NOT_SATISFIABLE", "Requested range is not satisfiable.", {
    "Content-Range": `bytes */${size}`,
  });
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === "*" || value === etag);
}

function contentDisposition(title: string, id: string): string {
  const fallback = `${id}.epub`;
  const displayName = `${title}.epub`;
  const encodedDisplayName = encodeURIComponent(displayName).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodedDisplayName}`;
}

function baseHeaders(book: CatalogBook): Headers {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, no-cache",
    "Content-Disposition": contentDisposition(book.title, book.id),
    "Content-Type": "application/epub+zip",
    ETag: `"${book.sha256}"`,
    "Last-Modified": new Date(book.updatedAt).toUTCString(),
  });
  return headers;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateObjectMetadata(object: R2Object, book: CatalogBook): void {
  if (object.size !== book.fileSize) {
    throw new ApiError(500, "BOOK_FILE_INVALID", "Book file metadata is invalid.");
  }
  const storedSha256 = object.checksums.sha256;
  if (storedSha256 !== undefined && toHex(storedSha256) !== book.sha256) {
    throw new ApiError(500, "BOOK_FILE_INVALID", "Book file metadata is invalid.");
  }
}

async function headBook(env: Env, book: CatalogBook): Promise<R2Object> {
  const metadata = await env.BOOKS.head(book.objectKey);
  if (metadata === null) {
    throw new ApiError(404, "NOT_FOUND", "Book file not found.");
  }
  validateObjectMetadata(metadata, book);
  return metadata;
}

export async function downloadBook(request: Request, env: Env, book: CatalogBook): Promise<Response> {
  const head = request.method === "HEAD";
  const headers = baseHeaders(book);
  const etag = headers.get("ETag")!;

  if (matchesEtag(request.headers.get("If-None-Match"), etag)) {
    await headBook(env, book);
    return new Response(null, { status: 304, headers });
  }

  if (head) {
    await headBook(env, book);
    headers.set("Content-Length", String(book.fileSize));
    return new Response(null, { status: 200, headers });
  }

  let range: ByteRange | null = null;
  let pinnedMetadata: R2Object | null = null;
  const rangeHeader = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  if (rangeHeader !== null && (ifRange === null || ifRange === etag)) {
    range = parseRange(rangeHeader, book.fileSize);
    // Pin resumptions to the exact R2 object observed before the read. The
    // public validator remains the edition SHA-256 from the catalog.
    if (ifRange === etag) pinnedMetadata = await headBook(env, book);
  }

  if (range !== null) {
    headers.set("Content-Length", String(range.length));
    headers.set("Content-Range", `bytes ${range.offset}-${range.end}/${book.fileSize}`);
  } else {
    headers.set("Content-Length", String(book.fileSize));
  }
  const getOptions: R2GetOptions = {};
  if (range !== null) {
    getOptions.range = { offset: range.offset, length: range.length };
  }
  if (pinnedMetadata !== null) {
    getOptions.onlyIf = { etagMatches: pinnedMetadata.etag };
  }

  const object = await env.BOOKS.get(book.objectKey, getOptions);
  if (object === null) {
    throw new ApiError(404, "NOT_FOUND", "Book file not found.");
  }
  if (!("body" in object)) {
    throw new ApiError(409, "BOOK_FILE_CHANGED", "Book file changed during the request.");
  }
  validateObjectMetadata(object, book);
  return new Response(object.body, { status: range === null ? 200 : 206, headers });
}
