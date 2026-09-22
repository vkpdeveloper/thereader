ALTER TABLE pending_uploads ADD COLUMN upload_id TEXT;
ALTER TABLE pending_uploads ADD COLUMN part_size INTEGER;

CREATE TABLE upload_parts (
  sha256 TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  PRIMARY KEY (sha256, part_number),
  FOREIGN KEY (sha256) REFERENCES pending_uploads(sha256) ON DELETE CASCADE
);
