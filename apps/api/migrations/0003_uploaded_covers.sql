ALTER TABLE uploaded_books ADD COLUMN cover_id TEXT;
ALTER TABLE uploaded_books ADD COLUMN cover_object_key TEXT;
ALTER TABLE uploaded_books ADD COLUMN cover_content_type TEXT;
ALTER TABLE uploaded_books ADD COLUMN cover_file_size INTEGER;
ALTER TABLE uploaded_books ADD COLUMN cover_etag TEXT;
ALTER TABLE uploaded_books ADD COLUMN cover_checked_at TEXT;

