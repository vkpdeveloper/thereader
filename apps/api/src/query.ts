import { ApiError } from "./errors";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 100;
const MAX_CURSOR_LENGTH = 512;

interface CursorPayload {
  v: 1;
  offset: number;
  q: string;
}

export interface ListQuery {
  limit: number;
  offset: number;
  query: string;
}

function singleParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length > 1) {
    throw new ApiError(400, "INVALID_QUERY", `Query parameter '${name}' must appear once.`);
  }
  return values[0] ?? null;
}

function decodeCursor(value: string): CursorPayload {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError(400, "INVALID_CURSOR", "Cursor is invalid.");
  }
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).v !== 1 ||
      !Number.isSafeInteger((parsed as Record<string, unknown>).offset) ||
      ((parsed as Record<string, unknown>).offset as number) < 0 ||
      typeof (parsed as Record<string, unknown>).q !== "string"
    ) {
      throw new Error("invalid cursor payload");
    }
    return parsed as unknown as CursorPayload;
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "Cursor is invalid.");
  }
}

export function encodeCursor(offset: number, query: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, offset, q: query }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function parseListQuery(url: URL): ListQuery {
  for (const name of url.searchParams.keys()) {
    if (name !== "limit" && name !== "cursor" && name !== "q") {
      throw new ApiError(400, "INVALID_QUERY", `Unknown query parameter '${name}'.`);
    }
  }

  const rawLimit = singleParam(url.searchParams, "limit");
  const rawQuery = singleParam(url.searchParams, "q");
  const rawCursor = singleParam(url.searchParams, "cursor");
  const query = rawQuery?.trim() ?? "";

  if (query.length > MAX_QUERY_LENGTH) {
    throw new ApiError(400, "INVALID_QUERY", `Search query must be at most ${MAX_QUERY_LENGTH} characters.`);
  }
  if (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit)) {
    throw new ApiError(400, "INVALID_QUERY", "Limit must be an integer from 1 to 100.");
  }
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > MAX_LIMIT) {
    throw new ApiError(400, "INVALID_QUERY", "Limit must be an integer from 1 to 100.");
  }

  let offset = 0;
  if (rawCursor !== null) {
    const cursor = decodeCursor(rawCursor);
    if (cursor.q !== query) {
      throw new ApiError(400, "INVALID_CURSOR", "Cursor does not match the search query.");
    }
    offset = cursor.offset;
  }
  return { limit, offset, query };
}
