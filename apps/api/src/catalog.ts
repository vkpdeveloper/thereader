import { ApiError } from "./errors";
import type { Book, CatalogBook, CatalogManifest, Env } from "./types";

export const CATALOG_KEY = "catalog/v1/manifest.json";
const MAX_CATALOG_BYTES = 1_000_000;
const MAX_BOOKS = 10_000;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const OBJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function containsHeaderUnsafeCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isSafeObjectKey(value: unknown, suffix?: string): value is string {
  return (
    isNonEmptyString(value, 512) &&
    OBJECT_KEY_PATTERN.test(value) &&
    !value.includes("//") &&
    !value.split("/").includes("..") &&
    (suffix === undefined || value.endsWith(suffix))
  );
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseBook(value: unknown): CatalogBook | null {
  if (!isRecord(value)) return null;
  const {
    id,
    version,
    title,
    author,
    description,
    language,
    subjects,
    coverUrl,
    downloadUrl,
    fileSize,
    sha256,
    updatedAt,
    objectKey,
    cover,
  } = value;

  if (
    !isNonEmptyString(id, 128) ||
    !ID_PATTERN.test(id) ||
    !isNonEmptyString(version, 64) ||
    !isNonEmptyString(title, 300) ||
    containsHeaderUnsafeCharacters(title) ||
    !isNonEmptyString(author, 300) ||
    !isBoundedString(description, 4_000) ||
    !isNonEmptyString(language, 35) ||
    !LANGUAGE_PATTERN.test(language) ||
    !Array.isArray(subjects) ||
    subjects.length > 32 ||
    !subjects.every((subject) => isNonEmptyString(subject, 100)) ||
    (coverUrl !== null && coverUrl !== `/v1/books/${id}/cover`) ||
    downloadUrl !== `/v1/books/${id}/download` ||
    !Number.isSafeInteger(fileSize) ||
    (fileSize as number) <= 0 ||
    !isNonEmptyString(sha256, 64) ||
    !SHA256_PATTERN.test(sha256) ||
    !isCanonicalIsoDate(updatedAt) ||
    !isSafeObjectKey(objectKey, ".epub")
  ) {
    return null;
  }

  let parsedCover: CatalogBook["cover"] = null;
  if (cover !== null) {
    if (!isRecord(cover)) return null;
    if (
      !isSafeObjectKey(cover.objectKey) ||
      !isNonEmptyString(cover.contentType, 100) ||
      containsHeaderUnsafeCharacters(cover.contentType) ||
      !cover.contentType.startsWith("image/") ||
      !Number.isSafeInteger(cover.fileSize) ||
      (cover.fileSize as number) <= 0 ||
      (cover.fileSize as number) > 10_000_000
    ) {
      return null;
    }
    parsedCover = {
      objectKey: cover.objectKey,
      contentType: cover.contentType,
      fileSize: cover.fileSize as number,
    };
  }

  if ((coverUrl === null) !== (parsedCover === null)) return null;

  return {
    id,
    version,
    title,
    author,
    description,
    language,
    subjects: [...subjects],
    coverUrl,
    downloadUrl,
    fileSize: fileSize as number,
    sha256,
    updatedAt,
    objectKey,
    cover: parsedCover,
  };
}

interface UploadedBookRow {
  id: string;
  sha256: string;
  version: string;
  title: string;
  author: string;
  description: string;
  language: string;
  subjects_json: string;
  file_size: number;
  object_key: string;
  updated_at: string;
}

function uploadedRowToBook(row: UploadedBookRow): CatalogBook {
  let subjects: unknown;
  try {
    subjects = JSON.parse(row.subjects_json);
  } catch {
    throw new ApiError(500, "CATALOG_INVALID", "Catalog data is invalid.");
  }
  const parsed = parseBook({
    id: row.id,
    version: row.version,
    title: row.title,
    author: row.author,
    description: row.description,
    language: row.language,
    subjects,
    coverUrl: null,
    downloadUrl: `/v1/books/${row.id}/download`,
    fileSize: row.file_size,
    sha256: row.sha256,
    updatedAt: row.updated_at,
    objectKey: row.object_key,
    cover: null,
  });
  if (parsed === null) throw new ApiError(500, "CATALOG_INVALID", "Catalog data is invalid.");
  return parsed;
}

async function loadUploadedBooks(env: Env): Promise<CatalogBook[]> {
  const result = await env.DB.prepare(
    `SELECT id, sha256, version, title, author, description, language,
            subjects_json, file_size, object_key, updated_at
       FROM uploaded_books
      ORDER BY updated_at, id
      LIMIT ?`,
  )
    .bind(MAX_BOOKS + 1)
    .all<UploadedBookRow>();
  if (result.results.length > MAX_BOOKS) {
    throw new ApiError(500, "CATALOG_INVALID", "Catalog data is invalid.");
  }
  return result.results.map(uploadedRowToBook);
}

async function loadLegacyCatalog(env: Env): Promise<CatalogManifest | null> {
  const object = await env.BOOKS.get(CATALOG_KEY);
  if (object === null) return null;
  if (object.size > MAX_CATALOG_BYTES) {
    throw new ApiError(500, "CATALOG_INVALID", "Catalog data is invalid.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await object.text());
  } catch {
    throw new ApiError(500, "CATALOG_INVALID", "Catalog data is invalid.");
  }

  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isCanonicalIsoDate(raw.generatedAt) || !Array.isArray(raw.books)) {
    throw new ApiError(500, "CATALOG_INVALID", "Catalog data is invalid.");
  }
  if (raw.books.length > MAX_BOOKS) {
    throw new ApiError(500, "CATALOG_INVALID", "Catalog data is invalid.");
  }

  const books: CatalogBook[] = [];
  const ids = new Set<string>();
  for (const rawBook of raw.books) {
    const book = parseBook(rawBook);
    if (book === null || ids.has(book.id)) {
      throw new ApiError(500, "CATALOG_INVALID", "Catalog data is invalid.");
    }
    ids.add(book.id);
    books.push(book);
  }

  return { schemaVersion: 1, generatedAt: raw.generatedAt, books };
}

export async function loadCatalog(env: Env): Promise<CatalogManifest> {
  const [legacy, uploaded] = await Promise.all([loadLegacyCatalog(env), loadUploadedBooks(env)]);
  if (legacy === null && uploaded.length === 0) {
    throw new ApiError(503, "CATALOG_UNAVAILABLE", "Catalog is unavailable.");
  }
  const books = [...(legacy?.books ?? [])];
  const ids = new Set(books.map((book) => book.id));
  const checksums = new Set(books.map((book) => book.sha256));
  for (const book of uploaded) {
    // The seeded manifest predates D1 and remains authoritative for its IDs.
    if (ids.has(book.id) || checksums.has(book.sha256)) continue;
    ids.add(book.id);
    checksums.add(book.sha256);
    books.push(book);
    if (books.length > MAX_BOOKS) {
      throw new ApiError(500, "CATALOG_INVALID", "Catalog data is invalid.");
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    books,
  };
}

export async function findPublishedBookBySha(env: Env, sha256: string): Promise<CatalogBook | null> {
  const legacy = await loadLegacyCatalog(env);
  const legacyBook = legacy?.books.find((book) => book.sha256 === sha256);
  if (legacyBook !== undefined) return legacyBook;
  const row = await env.DB.prepare(
    `SELECT id, sha256, version, title, author, description, language,
            subjects_json, file_size, object_key, updated_at
       FROM uploaded_books WHERE sha256 = ?`,
  )
    .bind(sha256)
    .first<UploadedBookRow>();
  return row === null ? null : uploadedRowToBook(row);
}

export function toPublicBook(book: CatalogBook): Book {
  const { objectKey: _objectKey, cover: _cover, ...publicBook } = book;
  return publicBook;
}

export function validateBookId(id: string): void {
  if (id.length > 128 || !ID_PATTERN.test(id)) {
    throw new ApiError(400, "INVALID_BOOK_ID", "Book ID is invalid.");
  }
}
