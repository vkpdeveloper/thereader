-- Reader highlights. `id` is the client-generated UUID; `rev` is a
-- server-assigned, monotonically increasing sequence bumped on every accepted
-- write so clients can pull "everything since rev N" regardless of clock skew.
-- Deletes are tombstones (`deleted_at`) so they propagate to other devices.
CREATE TABLE sync_highlights (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  text TEXT NOT NULL,
  color TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  deleted_at TEXT,
  change_id TEXT NOT NULL,
  rev INTEGER NOT NULL
);

CREATE UNIQUE INDEX sync_highlights_rev ON sync_highlights (rev);
CREATE INDEX sync_highlights_book ON sync_highlights (book_id, sha256);
