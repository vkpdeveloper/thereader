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
const PREFERENCES_BOOK_ID = "_preferences";
const PREFERENCES_SHA = "0".repeat(64);
const LOCATOR_KEYS = new Set(["href", "progression", "totalProgression", "title", "engine", "raw"]);
const PREFERENCE_KEYS = new Set(["fontSize", "lineHeight", "font", "flow", "marginScale", "justify", "keepAwake"]);

type ChangeKind = "progress" | "session" | "preferences" | "library";

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

interface PreferenceRow {
  value_json: string;
  updated_at: string;
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
  preferences: { value: unknown; updatedAt: string } | null;
  acceptedChangeIds?: string[];
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

function validPreferences(value: Record<string, unknown>): boolean {
  // Fields are optional so older/newer clients can rely on their local defaults.
  // Unknown fields are ignored by current clients and retained for forward compatibility.
  if (value.fontSize !== undefined && !inRange(value.fontSize, 14, 28)) return false;
  if (value.lineHeight !== undefined && !inRange(value.lineHeight, 1.2, 2.2)) return false;
  if (value.marginScale !== undefined && !inRange(value.marginScale, 0.5, 2)) return false;
  if (value.font !== undefined && value.font !== "serif" && value.font !== "sans") return false;
  if (value.flow !== undefined && value.flow !== "scrolled" && value.flow !== "paginated") return false;
  if (value.justify !== undefined && typeof value.justify !== "boolean") return false;
  if (value.keepAwake !== undefined && typeof value.keepAwake !== "boolean") return false;
  for (const key of PREFERENCE_KEYS) {
    if (key in value && value[key] === null) return false;
  }
  return true;
}

function parseChange(value: unknown, futureLimit: number): SyncChange {
  if (!isRecord(value)) throw invalidSync();
  const allowed = new Set(["id", "bookId", "sha256", "kind", "updatedAt", "payload"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidSync();
  if (!validClientId(value.id)) throw invalidSync("Change ID is invalid.");
  if (typeof value.kind !== "string" || !["progress", "session", "preferences", "library"].includes(value.kind)) {
    throw invalidSync("Change kind is invalid.");
  }
  const kind = value.kind as ChangeKind;
  const updatedAt = canonicalIsoDate(value.updatedAt, futureLimit);
  if (updatedAt === null) throw invalidSync("updatedAt is invalid or too far in the future.");
  if (!isRecord(value.payload) || payloadSize(value.payload) > MAX_PAYLOAD_BYTES) throw invalidSync("Change payload is invalid.");

  let bookId: string;
  let sha256: string;
  if (kind === "preferences") {
    if (value.bookId !== PREFERENCES_BOOK_ID || value.sha256 !== PREFERENCES_SHA) {
      throw invalidSync("Preferences must use the documented sentinel edition.");
    }
    if (Object.keys(value.payload).length !== 1 || !isRecord(value.payload.value) || !validPreferences(value.payload.value)) {
      throw invalidSync("Preferences payload is invalid.");
    }
    bookId = PREFERENCES_BOOK_ID;
    sha256 = PREFERENCES_SHA;
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
    case "preferences":
      return env.DB.prepare(
        `INSERT INTO sync_preferences (slot, change_id, updated_at, updated_ms, value_json)
         VALUES ('default', ?, ?, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET
           change_id = excluded.change_id, updated_at = excluded.updated_at,
           updated_ms = excluded.updated_ms, value_json = excluded.value_json
         WHERE excluded.updated_ms > sync_preferences.updated_ms
            OR (excluded.updated_ms = sync_preferences.updated_ms AND excluded.change_id > sync_preferences.change_id)`,
      ).bind(change.id, change.updatedAt, change.updatedMs, JSON.stringify(change.payload.value));
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
  const preference = await env.DB.prepare(
    "SELECT value_json, updated_at FROM sync_preferences WHERE slot = 'default'",
  ).first<PreferenceRow>();
  let parsedPreference: unknown | null = null;
  if (preference !== null) {
    try {
      parsedPreference = JSON.parse(preference.value_json);
      if (!isRecord(parsedPreference) || !validPreferences(parsedPreference)) throw new Error();
    } catch {
      throw new ApiError(500, "SYNC_STATE_INVALID", "Sync state is invalid.");
    }
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
    preferences: preference === null ? null : { value: parsedPreference, updatedAt: preference.updated_at },
  };
  if (acceptedChangeIds !== undefined) state.acceptedChangeIds = acceptedChangeIds;
  return state;
}

export async function pushSync(request: Request, env: Env): Promise<SyncState> {
  const raw = await readBoundedJson(request, MAX_SYNC_BYTES);
  if (!isRecord(raw) || !validClientId(raw.deviceId) || !Array.isArray(raw.changes) || raw.changes.length > MAX_CHANGES) {
    throw invalidSync();
  }
  if (Object.keys(raw).some((key) => key !== "deviceId" && key !== "changes")) throw invalidSync();
  const futureLimit = Date.now() + MAX_FUTURE_SKEW_MS;
  const changes = raw.changes.map((change) => parseChange(change, futureLimit));
  if (changes.length > 0) {
    await env.DB.batch(changes.map((change) => statementForChange(env, raw.deviceId as string, change)));
  }
  return getSyncState(env, changes.map((change) => change.id));
}
