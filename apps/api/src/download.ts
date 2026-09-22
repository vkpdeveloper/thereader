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
    "Cache-Control": "public, max-age=3600, immutable",
    "Content-Disposition": contentDisposition(book.title, book.id),
    "Content-Type": "application/epub+zip",
    ETag: `"${book.sha256}"`,
    "Last-Modified": new Date(book.updatedAt).toUTCString(),
  });
  return headers;
}

export async function downloadBook(request: Request, env: Env, book: CatalogBook): Promise<Response> {
  const head = request.method === "HEAD";
  const metadata = await env.BOOKS.head(book.objectKey);
  if (metadata === null) {
    throw new ApiError(404, "NOT_FOUND", "Book file not found.");
  }
  if (metadata.size !== book.fileSize) {
    throw new ApiError(500, "BOOK_FILE_INVALID", "Book file metadata is invalid.");
  }

  const headers = baseHeaders(book);
  const etag = headers.get("ETag")!;
  if (matchesEtag(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  let range: ByteRange | null = null;
  const rangeHeader = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  if (rangeHeader !== null && (ifRange === null || ifRange === etag)) {
    range = parseRange(rangeHeader, book.fileSize);
  }

  if (range !== null) {
    headers.set("Content-Length", String(range.length));
    headers.set("Content-Range", `bytes ${range.offset}-${range.end}/${book.fileSize}`);
  } else {
    headers.set("Content-Length", String(book.fileSize));
  }
  if (head) {
    return new Response(null, { status: range === null ? 200 : 206, headers });
  }

  const object = await env.BOOKS.get(
    book.objectKey,
    range === null ? undefined : { range: { offset: range.offset, length: range.length } },
  );
  if (object === null || !("body" in object)) {
    throw new ApiError(404, "NOT_FOUND", "Book file not found.");
  }
  if (object.size !== book.fileSize) {
    throw new ApiError(500, "BOOK_FILE_INVALID", "Book file metadata is invalid.");
  }
  return new Response(object.body, { status: range === null ? 200 : 206, headers });
}
