ALTER TABLE uploaded_books ADD COLUMN format TEXT NOT NULL DEFAULT 'epub' CHECK (format IN ('epub', 'comic'));
ALTER TABLE pending_uploads ADD COLUMN format TEXT NOT NULL DEFAULT 'epub' CHECK (format IN ('epub', 'comic'));
