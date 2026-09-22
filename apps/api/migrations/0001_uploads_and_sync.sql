CREATE TABLE uploaded_books (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  description TEXT NOT NULL,
  language TEXT NOT NULL,
  subjects_json TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL
);

CREATE INDEX uploaded_books_updated_at ON uploaded_books(updated_at, id);

CREATE TABLE pending_uploads (
  sha256 TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  description TEXT NOT NULL,
  language TEXT NOT NULL,
  subjects_json TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  prepared_at TEXT NOT NULL
);

CREATE TABLE sync_progress (
  book_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  change_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (book_id, sha256)
);

CREATE TABLE sync_library (
  book_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  change_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  added_at TEXT,
  PRIMARY KEY (book_id, sha256)
);

CREATE TABLE sync_sessions (
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  reading_ms INTEGER NOT NULL CHECK (reading_ms >= 0),
  PRIMARY KEY (device_id, session_id, book_id, sha256)
);

CREATE INDEX sync_sessions_book ON sync_sessions(book_id, sha256);

CREATE TABLE sync_preferences (
  slot TEXT PRIMARY KEY CHECK (slot = 'default'),
  change_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  value_json TEXT NOT NULL
);
