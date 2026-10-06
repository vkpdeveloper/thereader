import { canonicalIsoDate, isoTimestampOrder, isRecord, readBoundedJson } from "./body";
import { ApiError } from "./errors";
import type { Env } from "./types";

const MAX_SYNC_BYTES = 256 * 1024;
const MAX_CHANGES = 100;
const MAX_STATE_BOOKS = 1_000;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BOOK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Reader settings are per-device and never synced. Older clients still push
// them as `preferences` changes on this sentinel edition; the server
// acknowledges and drops them so those clients do not retry forever.
const PREFERENCES_BOOK_ID = "_preferences";
const PREFERENCES_SHA = "0".repeat(64);
const LOCATOR_KEYS = new Set(["href", "progression", "totalProgression", "title", "engine", "raw"]);
// Semantic colour keys (yellow, green, ...), resolved per theme by clients.
// A slug so newer clients can add colours without a server release.
const HIGHLIGHT_COLOR = /^[a-z]{1,16}$/;
const HIGHLIGHT_KEYS = new Set(["highlightId", "locator", "text", "color", "note", "createdAt", "deleted"]);
const MAX_HIGHLIGHT_TEXT = 4_000;
const MAX_HIGHLIGHT_NOTE = 4_000;
const MAX_HIGHLIGHT_LOCATOR_BYTES = 16 * 1024;
const MAX_HIGHLIGHTS_PAGE = 500;
// Saved web articles share the change envelope with a sentinel edition; the
// article itself is named by `payload.articleId`.
export const ARTICLES_BOOK_ID = "_articles";
const ARTICLES_SHA = "0".repeat(64);
// Clients derive the id from the article's normalized URL: the first 128 bits
// of its SHA-256, in lowercase hex.
const ARTICLE_ID = /^[a-f0-9]{32}$/;
const ARTICLE_KEYS = new Set([
  "articleId", "url", "title", "siteName", "byline", "excerpt", "leadImage", "favicon", "language", "dir",
  "wordCount", "readingMinutes", "blockCount", "publishedAt", "savedAt", "bodySha256", "bodySize", "schema", "deleted",
]);
const ARTICLE_POSITION_KEYS = new Set(["block", "offset", "percent"]);
const MAX_ARTICLE_URL = 2_048;
const MAX_ARTICLES_PAGE = 200;
/** Uncompressed article document cap, shared with the body endpoint. */
export const MAX_ARTICLE_BODY_BYTES = 4 * 1024 * 1024;
export const ARTICLE_SCHEMA = 1;
/** Where an article document lives in R2: content-addressed and immutable. */
export const articleBodyKey = (sha256: string): string => `articles/${sha256}`;
const CHANGE_KINDS = ["progress", "session", "preferences", "library", "highlight", "article", "articleProgress"];

type ChangeKind = "progress" | "session" | "library" | "highlight" | "article" | "articleProgress";

interface SyncChange {
  id: string;
  bookId: string;
  sha256: string;
  kind: ChangeKind;
  updatedAt: string;
  updatedMs: number;
  payload: Record<string, unknown>;
}

interface StateRow {
  book_id: string;
  sha256: string;
  library_present: number | null;
  added_at: string | null;
  library_updated_at: string | null;
  progress_json: string | null;
  progress_updated_at: string | null;
  progress_updated_ms: number | null;
  reading_ms: number;
  session_updated_at: string | null;
  session_updated_ms: number | null;
}

/** A legacy `preferences` change: acknowledged, never stored. */
interface IgnoredChange {
  id: string;
  kind: "preferences";
}

export interface SyncState {
  serverTime: string;
  books: Array<{
    bookId: string;
    sha256: string;
    inLibrary: boolean;
    addedAt: string | null;
    libraryUpdatedAt: string | null;
    progress: unknown | null;
    progressUpdatedAt: string | null;
    lastOpenedAt: string | null;
    readingMilliseconds: number;
  }>;
  acceptedChangeIds?: string[];
  // Present only when the request asked for it via `highlightsSince`, so
  // older clients see an unchanged response and cost no extra D1 reads.
  highlights?: {
    items: SyncHighlight[];
    cursor: number;
    more: boolean;
  };
  // Present only when the request asked for it via `articlesSince`.
  articles?: {
    items: SyncArticle[];
    cursor: number;
    more: boolean;
  };
}

export interface ArticlePosition {
  block: number;
  offset: number;
  percent: number;
}

export interface SyncArticle {
  id: string;
  url: string;
  title: string;
  siteName: string | null;
  byline: string | null;
  excerpt: string | null;
  leadImage: string | null;
  favicon: string | null;
  language: string | null;
  dir: "ltr" | "rtl";
  wordCount: number;
  readingMinutes: number;
  blockCount: number;
  publishedAt: string | null;
  savedAt: string | null;
  bodySha256: string | null;
  bodySize: number | null;
  schema: number;
  position: ArticlePosition | null;
  positionUpdatedAt: string | null;
  updatedAt: string;
  deleted: boolean;
}

interface ArticleRow {
  id: string;
  url: string;
  title: string;
  site_name: string | null;
  byline: string | null;
  excerpt: string | null;
  lead_image: string | null;
  favicon: string | null;
  language: string | null;
  dir: string;
  word_count: number;
  reading_minutes: number;
  block_count: number;
  published_at: string | null;
  saved_at: string | null;
  body_sha256: string | null;
  body_size: number | null;
  schema: number;
  position_json: string | null;
  position_updated_at: string | null;
  updated_at: string;
  deleted_at: string | null;
  rev: number;
}

export interface SyncHighlight {
  id: string;
  bookId: string;
  sha256: string;
  locator: Record<string, unknown>;
  text: string;
  color: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

interface HighlightRow {
  id: string;
  book_id: string;
  sha256: string;
  locator_json: string;
  text: string;
  color: string;
  note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  rev: number;
}

function invalidSync(message = "Sync request is invalid."): ApiError {
  return new ApiError(400, "INVALID_SYNC", message);
}

function validClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

function payloadSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function inRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validOptionalBoundedString(value: unknown, maximum: number): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.length <= maximum);
}

function validLocator(value: Record<string, unknown>): boolean {
  if (Object.keys(value).some((key) => !LOCATOR_KEYS.has(key))) return false;
  if (typeof value.href !== "string" || value.href.length === 0 || value.href.length > 4_096) return false;
  if (!inRange(value.progression, 0, 1)) return false;
  if (value.totalProgression !== undefined && value.totalProgression !== null && !inRange(value.totalProgression, 0, 1)) return false;
  if (!validOptionalBoundedString(value.title, 1_000) || !validOptionalBoundedString(value.engine, 64)) return false;
  if (value.raw !== undefined && value.raw !== null && !isRecord(value.raw)) return false;
  return true;
}

// Readium locators carry href plus free-form `locations` and `text` objects;
// only the href is required, and the whole thing is size-bounded.
function validHighlightLocator(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (typeof value.href !== "string" || value.href.length === 0 || value.href.length > 4_096) return false;
  return payloadSize(value) <= MAX_HIGHLIGHT_LOCATOR_BYTES;
}

function validHighlightPayload(value: Record<string, unknown>, futureLimit: number): boolean {
  if (Object.keys(value).some((key) => !HIGHLIGHT_KEYS.has(key))) return false;
  if (!validClientId(value.highlightId)) return false;
  if (typeof value.deleted !== "boolean") return false;
  if (!validHighlightLocator(value.locator)) return false;
  if (typeof value.text !== "string" || value.text.length > MAX_HIGHLIGHT_TEXT) return false;
  if (typeof value.color !== "string" || !HIGHLIGHT_COLOR.test(value.color)) return false;
  if (!validOptionalBoundedString(value.note, MAX_HIGHLIGHT_NOTE)) return false;
  return canonicalIsoDate(value.createdAt, futureLimit) !== null;
}

function optionalText(value: unknown, maximum: number): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.length <= maximum);
}

function webUrl(value: unknown): boolean {
  return typeof value === "string" && value.length <= MAX_ARTICLE_URL && /^https?:\/\/[^\s]+$/i.test(value);
}

// Images may be inline `data:` URLs; anything longer than a URL is dropped by clients.
function optionalImageUrl(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.length <= MAX_ARTICLE_URL && /^(?:https?:\/\/|data:image\/)[^\s]+$/i.test(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function validArticlePosition(value: unknown): value is ArticlePosition {
  if (!isRecord(value) || Object.keys(value).some((key) => !ARTICLE_POSITION_KEYS.has(key))) return false;
  return boundedInteger(value.block, 0, 1_000_000) && inRange(value.offset, 0, 1) && inRange(value.percent, 0, 1);
}

// A saved article's metadata, or a tombstone (`{articleId, deleted: true}`).
function validArticlePayload(value: Record<string, unknown>, futureLimit: number): boolean {
  if (Object.keys(value).some((key) => !ARTICLE_KEYS.has(key))) return false;
  if (typeof value.articleId !== "string" || !ARTICLE_ID.test(value.articleId)) return false;
  if (typeof value.deleted !== "boolean") return false;
  if (value.deleted) return Object.keys(value).length === 2;
  if (!webUrl(value.url)) return false;
  if (typeof value.title !== "string" || value.title.length > 1_000) return false;
  if (!optionalText(value.siteName, 300) || !optionalText(value.byline, 500) || !optionalText(value.excerpt, 2_000)) return false;
  if (!optionalImageUrl(value.leadImage) || !optionalImageUrl(value.favicon)) return false;
  if (!optionalText(value.language, 35) || !optionalText(value.publishedAt, 64)) return false;
  if (value.dir !== "ltr" && value.dir !== "rtl") return false;
  if (!boundedInteger(value.wordCount, 0, 10_000_000) || !boundedInteger(value.readingMinutes, 1, 100_000)) return false;
  if (!boundedInteger(value.blockCount, 0, 1_000_000)) return false;
  if (typeof value.bodySha256 !== "string" || !SHA256_PATTERN.test(value.bodySha256)) return false;
  if (!boundedInteger(value.bodySize, 1, MAX_ARTICLE_BODY_BYTES) || value.schema !== ARTICLE_SCHEMA) return false;
  return canonicalIsoDate(value.savedAt, futureLimit) !== null;
}

function validArticleProgressPayload(value: Record<string, unknown>): boolean {
  if (Object.keys(value).some((key) => key !== "articleId" && key !== "position")) return false;
  return typeof value.articleId === "string" && ARTICLE_ID.test(value.articleId) && validArticlePosition(value.position);
}

function parseChange(value: unknown, futureLimit: number): SyncChange | IgnoredChange {
  if (!isRecord(value)) throw invalidSync();
  const allowed = new Set(["id", "bookId", "sha256", "kind", "updatedAt", "payload"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidSync();
  if (!validClientId(value.id)) throw invalidSync("Change ID is invalid.");
  if (typeof value.kind !== "string" || !CHANGE_KINDS.includes(value.kind)) {
    throw invalidSync("Change kind is invalid.");
  }
  if (value.kind === "preferences") {
    if (value.bookId !== PREFERENCES_BOOK_ID || value.sha256 !== PREFERENCES_SHA) {
      throw invalidSync("Preferences must use the documented sentinel edition.");
    }
    return { id: value.id, kind: "preferences" };
  }
  const kind = value.kind as ChangeKind;
  const updatedAt = canonicalIsoDate(value.updatedAt, futureLimit);
  if (updatedAt === null) throw invalidSync("updatedAt is invalid or too far in the future.");
  if (!isRecord(value.payload) || payloadSize(value.payload) > MAX_PAYLOAD_BYTES) throw invalidSync("Change payload is invalid.");

  let bookId: string;
  let sha256: string;
  if (kind === "article" || kind === "articleProgress") {
    if (value.bookId !== ARTICLES_BOOK_ID || value.sha256 !== ARTICLES_SHA) {
      throw invalidSync("Articles must use the documented sentinel edition.");
    }
    const valid = kind === "article"
      ? validArticlePayload(value.payload, futureLimit)
      : validArticleProgressPayload(value.payload);
    if (!valid) throw invalidSync("Article payload is invalid.");
    bookId = ARTICLES_BOOK_ID;
    sha256 = ARTICLES_SHA;
  } else {
    if (typeof value.bookId !== "string" || value.bookId.length > 128 || !BOOK_ID_PATTERN.test(value.bookId)) {
      throw invalidSync("bookId is invalid.");
    }
    if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) throw invalidSync("sha256 is invalid.");
    bookId = value.bookId;
    sha256 = value.sha256;
    if (kind === "progress" && !validLocator(value.payload)) throw invalidSync("Progress payload is invalid.");
    if (kind === "session") {
      if (Object.keys(value.payload).length !== 1 || !Number.isSafeInteger(value.payload.readingMilliseconds)) {
        throw invalidSync("Session payload is invalid.");
      }
      const elapsed = value.payload.readingMilliseconds as number;
      if (elapsed < 0 || elapsed > MAX_SESSION_MS) throw invalidSync("Session duration is invalid.");
    }
    if (kind === "highlight" && !validHighlightPayload(value.payload, futureLimit)) {
      throw invalidSync("Highlight payload is invalid.");
    }
    if (kind === "library") {
      if (Object.keys(value.payload).some((key) => key !== "present" && key !== "addedAt") || typeof value.payload.present !== "boolean") {
        throw invalidSync("Library payload is invalid.");
      }
      if (value.payload.present) {
        if (canonicalIsoDate(value.payload.addedAt, futureLimit) === null) throw invalidSync("Library addedAt is invalid.");
      } else if (value.payload.addedAt !== null) {
        throw invalidSync("Removed library entries must use a null addedAt.");
      }
    }
  }
  return {
    id: value.id,
    bookId,
    sha256,
    kind,
    updatedAt,
    updatedMs: isoTimestampOrder(updatedAt),
    payload: value.payload,
  };
}

function statementForChange(env: Env, deviceId: string, change: SyncChange): D1PreparedStatement {
  switch (change.kind) {
    case "progress":
      return env.DB.prepare(
        `INSERT INTO sync_progress (book_id, sha256, change_id, updated_at, updated_ms, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(book_id, sha256) DO UPDATE SET
           change_id = excluded.change_id, updated_at = excluded.updated_at,
           updated_ms = excluded.updated_ms, payload_json = excluded.payload_json
         WHERE excluded.updated_ms > sync_progress.updated_ms
            OR (excluded.updated_ms = sync_progress.updated_ms AND excluded.change_id > sync_progress.change_id)`,
      ).bind(change.bookId, change.sha256, change.id, change.updatedAt, change.updatedMs, JSON.stringify(change.payload));
    case "library":
      return env.DB.prepare(
        `INSERT INTO sync_library (book_id, sha256, change_id, updated_at, updated_ms, present, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(book_id, sha256) DO UPDATE SET
           change_id = excluded.change_id, updated_at = excluded.updated_at,
           updated_ms = excluded.updated_ms, present = excluded.present, added_at = excluded.added_at
         WHERE excluded.updated_ms > sync_library.updated_ms
            OR (excluded.updated_ms = sync_library.updated_ms AND excluded.change_id > sync_library.change_id)`,
      ).bind(
        change.bookId,
        change.sha256,
        change.id,
        change.updatedAt,
        change.updatedMs,
        change.payload.present ? 1 : 0,
        change.payload.addedAt,
      );
    case "session":
      return env.DB.prepare(
        `INSERT INTO sync_sessions
           (device_id, session_id, book_id, sha256, updated_at, updated_ms, reading_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, session_id, book_id, sha256) DO UPDATE SET
           reading_ms = MAX(sync_sessions.reading_ms, excluded.reading_ms),
           updated_at = CASE WHEN excluded.updated_ms > sync_sessions.updated_ms THEN excluded.updated_at ELSE sync_sessions.updated_at END,
           updated_ms = MAX(sync_sessions.updated_ms, excluded.updated_ms)`,
      ).bind(
        deviceId,
        change.id,
        change.bookId,
        change.sha256,
        change.updatedAt,
        change.updatedMs,
        change.payload.readingMilliseconds,
      );
    case "highlight": {
      // Batched statements run sequentially in one transaction, so MAX(rev)+1
      // hands out a unique, increasing rev per accepted write. A rejected
      // (older) write keeps the row and its rev untouched.
      const payload = change.payload;
      return env.DB.prepare(
        `INSERT INTO sync_highlights
           (id, book_id, sha256, locator_json, text, color, note, created_at,
            updated_at, updated_ms, deleted_at, change_id, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 (SELECT COALESCE(MAX(rev), 0) + 1 FROM sync_highlights))
         ON CONFLICT(id) DO UPDATE SET
           locator_json = excluded.locator_json, text = excluded.text,
           color = excluded.color, note = excluded.note,
           updated_at = excluded.updated_at, updated_ms = excluded.updated_ms,
           deleted_at = excluded.deleted_at, change_id = excluded.change_id,
           rev = excluded.rev
         WHERE (excluded.updated_ms > sync_highlights.updated_ms
             OR (excluded.updated_ms = sync_highlights.updated_ms AND excluded.change_id > sync_highlights.change_id))
           AND excluded.book_id = sync_highlights.book_id
           AND excluded.sha256 = sync_highlights.sha256`,
      ).bind(
        payload.highlightId,
        change.bookId,
        change.sha256,
        JSON.stringify(payload.locator),
        payload.text,
        payload.color,
        typeof payload.note === "string" ? payload.note : null,
        payload.createdAt,
        change.updatedAt,
        change.updatedMs,
        payload.deleted ? change.updatedAt : null,
        change.id,
      );
    }
    case "article": {
      const payload = change.payload;
      const nextRev = "(SELECT COALESCE(MAX(rev), 0) + 1 FROM sync_articles)";
      const newer = `(excluded.updated_ms > sync_articles.updated_ms
             OR (excluded.updated_ms = sync_articles.updated_ms AND excluded.change_id > sync_articles.change_id))`;
      if (payload.deleted) {
        // A tombstone keeps the last metadata; a tombstone for an id this
        // server never saw is stored with empty metadata.
        return env.DB.prepare(
          `INSERT INTO sync_articles (id, url, title, updated_at, updated_ms, deleted_at, change_id, rev)
           VALUES (?, '', '', ?, ?, ?, ?, ${nextRev})
           ON CONFLICT(id) DO UPDATE SET
             updated_at = excluded.updated_at, updated_ms = excluded.updated_ms,
             deleted_at = excluded.deleted_at, change_id = excluded.change_id, rev = excluded.rev
           WHERE ${newer}`,
        ).bind(payload.articleId, change.updatedAt, change.updatedMs, change.updatedAt, change.id);
      }
      // Saving again over a tombstone resurrects the article with a fresh
      // reading position; saving over a live row keeps its position.
      const keepPosition = (column: string) => `CASE WHEN sync_articles.deleted_at IS NULL THEN sync_articles.${column} END`;
      const text = (key: string) => (typeof payload[key] === "string" ? payload[key] : null);
      return env.DB.prepare(
        `INSERT INTO sync_articles
           (id, url, title, site_name, byline, excerpt, lead_image, favicon, language, dir,
            word_count, reading_minutes, block_count, published_at, saved_at, body_sha256, body_size,
            schema, updated_at, updated_ms, deleted_at, change_id, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ${nextRev})
         ON CONFLICT(id) DO UPDATE SET
           url = excluded.url, title = excluded.title, site_name = excluded.site_name,
           byline = excluded.byline, excerpt = excluded.excerpt, lead_image = excluded.lead_image,
           favicon = excluded.favicon, language = excluded.language, dir = excluded.dir,
           word_count = excluded.word_count, reading_minutes = excluded.reading_minutes,
           block_count = excluded.block_count, published_at = excluded.published_at,
           saved_at = excluded.saved_at, body_sha256 = excluded.body_sha256,
           body_size = excluded.body_size, schema = excluded.schema,
           position_json = ${keepPosition("position_json")},
           position_updated_at = ${keepPosition("position_updated_at")},
           position_updated_ms = ${keepPosition("position_updated_ms")},
           position_change_id = ${keepPosition("position_change_id")},
           updated_at = excluded.updated_at, updated_ms = excluded.updated_ms,
           deleted_at = NULL, change_id = excluded.change_id, rev = excluded.rev
         WHERE ${newer}`,
      ).bind(
        payload.articleId,
        payload.url,
        payload.title,
        text("siteName"),
        text("byline"),
        text("excerpt"),
        text("leadImage"),
        text("favicon"),
        text("language"),
        payload.dir,
        payload.wordCount,
        payload.readingMinutes,
        payload.blockCount,
        text("publishedAt"),
        payload.savedAt,
        payload.bodySha256,
        payload.bodySize,
        payload.schema,
        change.updatedAt,
        change.updatedMs,
        change.id,
      );
    }
    case "articleProgress": {
      // Positions only move live articles, ordered on their own clock like
      // book progress. A position for an unknown or deleted id is dropped.
      const payload = change.payload;
      return env.DB.prepare(
        `UPDATE sync_articles SET
           position_json = ?, position_updated_at = ?, position_updated_ms = ?, position_change_id = ?,
           rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM sync_articles)
         WHERE id = ? AND deleted_at IS NULL
           AND (position_updated_ms IS NULL OR ? > position_updated_ms
             OR (? = position_updated_ms AND ? > position_change_id))`,
      ).bind(
        JSON.stringify(payload.position),
        change.updatedAt,
        change.updatedMs,
        change.id,
        payload.articleId,
        change.updatedMs,
        change.updatedMs,
        change.id,
      );
    }
  }
}

function laterTimestamp(row: StateRow): string | null {
  if (row.progress_updated_ms === null) return row.session_updated_at;
  if (row.session_updated_ms === null) return row.progress_updated_at;
  return row.progress_updated_ms >= row.session_updated_ms ? row.progress_updated_at : row.session_updated_at;
}

export async function getSyncState(env: Env, acceptedChangeIds?: string[]): Promise<SyncState> {
  const rows = await env.DB.prepare(
    `WITH keys AS (
       SELECT book_id, sha256 FROM sync_progress
       UNION SELECT book_id, sha256 FROM sync_library
       UNION SELECT book_id, sha256 FROM sync_sessions
     ), sessions AS (
       SELECT book_id, sha256, SUM(reading_ms) AS reading_ms,
              MAX(updated_ms) AS session_updated_ms
         FROM sync_sessions GROUP BY book_id, sha256
     ), latest_session AS (
       SELECT s.book_id, s.sha256, s.reading_ms, s.session_updated_ms,
              MAX(x.updated_at) AS session_updated_at
         FROM sessions s
         JOIN sync_sessions x ON x.book_id = s.book_id AND x.sha256 = s.sha256
                             AND x.updated_ms = s.session_updated_ms
        GROUP BY s.book_id, s.sha256
     )
     SELECT k.book_id, k.sha256,
            l.present AS library_present, l.added_at, l.updated_at AS library_updated_at,
            p.payload_json AS progress_json, p.updated_at AS progress_updated_at,
            p.updated_ms AS progress_updated_ms,
            COALESCE(s.reading_ms, 0) AS reading_ms,
            s.session_updated_at, s.session_updated_ms
       FROM keys k
       LEFT JOIN sync_library l ON l.book_id = k.book_id AND l.sha256 = k.sha256
       LEFT JOIN sync_progress p ON p.book_id = k.book_id AND p.sha256 = k.sha256
       LEFT JOIN latest_session s ON s.book_id = k.book_id AND s.sha256 = k.sha256
      ORDER BY k.book_id, k.sha256
      LIMIT ?`,
  )
    .bind(MAX_STATE_BOOKS + 1)
    .all<StateRow>();
  if (rows.results.length > MAX_STATE_BOOKS) {
    throw new ApiError(409, "SYNC_STATE_TOO_LARGE", "Sync state exceeds the personal profile limit.");
  }
  const books = rows.results.map((row) => {
    let progress: unknown | null = null;
    if (row.progress_json !== null) {
      try {
        progress = JSON.parse(row.progress_json);
        if (!isRecord(progress) || !validLocator(progress)) throw new Error();
      } catch {
        throw new ApiError(500, "SYNC_STATE_INVALID", "Sync state is invalid.");
      }
    }
    return {
      bookId: row.book_id,
      sha256: row.sha256,
      inLibrary: row.library_present === 1,
      addedAt: row.added_at,
      libraryUpdatedAt: row.library_updated_at,
      progress,
      progressUpdatedAt: row.progress_updated_at,
      lastOpenedAt: laterTimestamp(row),
      readingMilliseconds: (() => {
        const milliseconds = Number(row.reading_ms);
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
          throw new ApiError(500, "SYNC_STATE_INVALID", "Sync state is invalid.");
        }
        return milliseconds;
      })(),
    };
  });
  const state: SyncState = {
    serverTime: new Date().toISOString(),
    books,
  };
  if (acceptedChangeIds !== undefined) state.acceptedChangeIds = acceptedChangeIds;
  return state;
}

function invalidState(): ApiError {
  return new ApiError(500, "SYNC_STATE_INVALID", "Sync state is invalid.");
}

// Pulls highlight rows written after `since` (a server rev), tombstones
// included, in rev order. Only changed rows are read; `more` asks the client
// to page again on its next sync.
async function highlightsSince(env: Env, since: number): Promise<NonNullable<SyncState["highlights"]>> {
  const rows = await env.DB.prepare(
    `SELECT id, book_id, sha256, locator_json, text, color, note, created_at,
            updated_at, deleted_at, rev
       FROM sync_highlights WHERE rev > ? ORDER BY rev LIMIT ?`,
  )
    .bind(since, MAX_HIGHLIGHTS_PAGE + 1)
    .all<HighlightRow>();
  const more = rows.results.length > MAX_HIGHLIGHTS_PAGE;
  const page = more ? rows.results.slice(0, MAX_HIGHLIGHTS_PAGE) : rows.results;
  const items = page.map((row): SyncHighlight => {
    let locator: unknown;
    try {
      locator = JSON.parse(row.locator_json);
    } catch {
      throw invalidState();
    }
    if (!validHighlightLocator(locator) || !HIGHLIGHT_COLOR.test(row.color)) throw invalidState();
    return {
      id: row.id,
      bookId: row.book_id,
      sha256: row.sha256,
      locator,
      text: row.text,
      color: row.color,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deleted: row.deleted_at !== null,
    };
  });
  return { items, cursor: page.length === 0 ? since : page[page.length - 1]!.rev, more };
}

// Pulls article rows written after `since` (a server rev), tombstones and
// position moves included, in rev order. Bodies are fetched separately.
async function articlesSince(env: Env, since: number): Promise<NonNullable<SyncState["articles"]>> {
  const rows = await env.DB.prepare(
    `SELECT id, url, title, site_name, byline, excerpt, lead_image, favicon, language, dir,
            word_count, reading_minutes, block_count, published_at, saved_at, body_sha256, body_size,
            schema, position_json, position_updated_at, updated_at, deleted_at, rev
       FROM sync_articles WHERE rev > ? ORDER BY rev LIMIT ?`,
  )
    .bind(since, MAX_ARTICLES_PAGE + 1)
    .all<ArticleRow>();
  const more = rows.results.length > MAX_ARTICLES_PAGE;
  const page = more ? rows.results.slice(0, MAX_ARTICLES_PAGE) : rows.results;
  const items = page.map((row): SyncArticle => {
    let position: unknown = null;
    if (row.position_json !== null) {
      try {
        position = JSON.parse(row.position_json);
      } catch {
        throw invalidState();
      }
      if (!validArticlePosition(position)) throw invalidState();
    }
    return {
      id: row.id,
      url: row.url,
      title: row.title,
      siteName: row.site_name,
      byline: row.byline,
      excerpt: row.excerpt,
      leadImage: row.lead_image,
      favicon: row.favicon,
      language: row.language,
      dir: row.dir === "rtl" ? "rtl" : "ltr",
      wordCount: row.word_count,
      readingMinutes: row.reading_minutes,
      blockCount: row.block_count,
      publishedAt: row.published_at,
      savedAt: row.saved_at,
      bodySha256: row.body_sha256,
      bodySize: row.body_size,
      schema: row.schema,
      position: position as ArticlePosition | null,
      positionUpdatedAt: row.position_updated_at,
      updatedAt: row.updated_at,
      deleted: row.deleted_at !== null,
    };
  });
  return { items, cursor: page.length === 0 ? since : page[page.length - 1]!.rev, more };
}

// Within one atomic batch, article saves run before positions so a position
// queued right after its save lands on the row the save creates.
function articleOrder(change: SyncChange): number {
  return change.kind === "articleProgress" ? 1 : 0;
}

// Deletes the documents of articles this request deleted, unless a live
// article still references them: one indexed read and one R2 call. Saving the
// article again uploads the document again (clients upload after their save
// is accepted, so a save never points at a document deleted here). A failure
// only leaves an orphaned object behind; the sync itself has already landed.
async function deleteUnreferencedBodies(env: Env, tombstones: SyncChange[]): Promise<void> {
  if (tombstones.length === 0) return;
  try {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT a.body_sha256 AS sha256
         FROM json_each(?) t
         JOIN sync_articles a ON a.id = json_extract(t.value, '$[0]') AND a.change_id = json_extract(t.value, '$[1]')
        WHERE a.deleted_at IS NOT NULL AND a.body_sha256 IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM sync_articles b WHERE b.body_sha256 = a.body_sha256 AND b.deleted_at IS NULL)`,
    )
      .bind(JSON.stringify(tombstones.map((change) => [change.payload.articleId, change.id])))
      .all<{ sha256: string }>();
    if (rows.results.length > 0) await env.BOOKS.delete(rows.results.map((row) => articleBodyKey(row.sha256)));
  } catch (error) {
    console.error("Article document cleanup failed", error instanceof Error ? error.message : "Unknown error");
  }
}

export async function pushSync(request: Request, env: Env): Promise<SyncState> {
  const raw = await readBoundedJson(request, MAX_SYNC_BYTES);
  if (!isRecord(raw) || !validClientId(raw.deviceId) || !Array.isArray(raw.changes) || raw.changes.length > MAX_CHANGES) {
    throw invalidSync();
  }
  const allowed = new Set(["deviceId", "changes", "highlightsSince", "articlesSince"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw invalidSync();
  // Optional: absent means an older client that knows nothing of highlights;
  // null means "send the full set"; a number is the last rev the client saw.
  const wantsHighlights = "highlightsSince" in raw;
  const since = raw.highlightsSince ?? 0;
  if (wantsHighlights && (!Number.isSafeInteger(since) || (since as number) < 0)) throw invalidSync("highlightsSince is invalid.");
  // Same contract for articles: absent, null (everything) or the last cursor.
  const wantsArticles = "articlesSince" in raw;
  const articlesFrom = raw.articlesSince ?? 0;
  if (wantsArticles && (!Number.isSafeInteger(articlesFrom) || (articlesFrom as number) < 0)) throw invalidSync("articlesSince is invalid.");
  const futureLimit = Date.now() + MAX_FUTURE_SKEW_MS;
  const parsed = raw.changes.map((change) => parseChange(change, futureLimit));
  const changes = parsed.filter((change): change is SyncChange => change.kind !== "preferences");
  if (changes.length > 0) {
    // Array.prototype.sort is stable, so other changes keep their order.
    const ordered = [...changes].sort((a, b) => articleOrder(a) - articleOrder(b));
    await env.DB.batch(ordered.map((change) => statementForChange(env, raw.deviceId as string, change)));
    // A tombstone is accepted when its change id now owns the row.
    await deleteUnreferencedBodies(env, changes.filter((change) => change.kind === "article" && change.payload.deleted === true));
  }
  // Ignored legacy changes are acknowledged too, so their senders drop them.
  const state = await getSyncState(env, parsed.map((change) => change.id));
  if (wantsHighlights) state.highlights = await highlightsSince(env, since as number);
  if (wantsArticles) state.articles = await articlesSince(env, articlesFrom as number);
  return state;
}
