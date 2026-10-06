-- Saved web articles. `id` is derived by clients from the article's
-- normalized URL (see docs/cloud-sync.md), so the same story saved on two
-- devices converges on one row. Only metadata, reading position and
-- deletions live here; the extracted document is an immutable R2 object
-- keyed by `body_sha256`. `rev` is a server-assigned, monotonically
-- increasing sequence bumped on every accepted write (metadata, tombstone or
-- position) so clients pull "everything since rev N". Deletes are tombstones
-- (`deleted_at`) so they propagate; tombstone rows may carry empty metadata.
CREATE TABLE sync_articles (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  site_name TEXT,
  byline TEXT,
  excerpt TEXT,
  lead_image TEXT,
  favicon TEXT,
  language TEXT,
  dir TEXT NOT NULL DEFAULT 'ltr',
  word_count INTEGER NOT NULL DEFAULT 0,
  reading_minutes INTEGER NOT NULL DEFAULT 1,
  block_count INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  saved_at TEXT,
  body_sha256 TEXT,
  body_size INTEGER,
  schema INTEGER NOT NULL DEFAULT 1,
  position_json TEXT,
  position_updated_at TEXT,
  position_updated_ms INTEGER,
  position_change_id TEXT,
  updated_at TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  deleted_at TEXT,
  change_id TEXT NOT NULL,
  rev INTEGER NOT NULL
);

CREATE UNIQUE INDEX sync_articles_rev ON sync_articles (rev);
