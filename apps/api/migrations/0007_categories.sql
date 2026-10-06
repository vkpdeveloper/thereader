-- Library categories (see docs/categories.md). `id` is the client-generated
-- UUID. Renames and recolours are last-write-wins; deletes are tombstones
-- (`deleted_at`) and final, so a deleted category never comes back. Tombstone
-- rows for ids this server never saw carry empty metadata.
CREATE TABLE sync_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  deleted_at TEXT,
  change_id TEXT NOT NULL,
  rev INTEGER NOT NULL
);

-- Which category a book or saved article is in, at most one per item.
-- `category_id` NULL means uncategorized; it is not a foreign key, because an
-- assignment may arrive before its category and clients treat unknown or
-- deleted categories as uncategorized.
CREATE TABLE sync_category_items (
  item_type TEXT NOT NULL CHECK (item_type IN ('book', 'article')),
  item_id TEXT NOT NULL,
  category_id TEXT,
  updated_at TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  change_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id)
);

-- Both tables share ONE server rev sequence so a single cursor pages through
-- them. Every accepted write takes 1 + the larger of the two tables' MAX(rev).
-- Each MAX is a single seek on these indexes, and statements in a D1 batch
-- run sequentially in one transaction, so every rev handed out is unique
-- across both tables and increasing. Rows are never deleted, so the maximum
-- never moves backwards; a rejected (older) write takes no rev. This needs no
-- counter row, which would cost an extra statement per write.
CREATE UNIQUE INDEX sync_categories_rev ON sync_categories (rev);
CREATE UNIQUE INDEX sync_category_items_rev ON sync_category_items (rev);
