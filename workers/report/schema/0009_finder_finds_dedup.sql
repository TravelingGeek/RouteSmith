-- =============================================================================
-- Routesmith D1 Schema — Migration 0009
-- 1. Add UNIQUE constraint on finder_finds (finder_id, gc_code, find_date)
--    for reliable deduplication on incremental GPX uploads.
-- 2. Add report_invalidated_at to trips — set when GPX uploaded or trip edited.
--    Dashboard shows "Outdated" badge if invalidated_at > last report generated_at.
-- =============================================================================

-- Step 1: Create new finder_finds table with unique constraint
-- (SQLite doesn't support ADD CONSTRAINT on existing tables)
CREATE TABLE IF NOT EXISTS finder_finds_new (
    find_id        TEXT PRIMARY KEY,
    finder_id      TEXT NOT NULL REFERENCES finders (finder_id),
    gc_code        TEXT NOT NULL,
    cache_name     TEXT,
    cache_owner    TEXT,
    find_date      TEXT NOT NULL,
    county         TEXT,
    state          TEXT,
    country        TEXT,
    cache_type     TEXT,
    difficulty     REAL,
    terrain        REAL,
    fav_points     INTEGER NOT NULL DEFAULT 0,
    lat            REAL,
    lon            REAL,
    placement_date TEXT,
    UNIQUE (finder_id, gc_code, find_date)
);

-- Copy existing data — on conflict keep existing row
INSERT OR IGNORE INTO finder_finds_new
SELECT * FROM finder_finds;

-- Swap tables
DROP TABLE finder_finds;
ALTER TABLE finder_finds_new RENAME TO finder_finds;

-- Restore indexes
CREATE INDEX IF NOT EXISTS idx_ff_finder_date ON finder_finds (finder_id, find_date);
CREATE INDEX IF NOT EXISTS idx_ff_finder_gc   ON finder_finds (finder_id, gc_code, find_date);

-- Step 2: Add report_invalidated_at to trips
ALTER TABLE trips ADD COLUMN report_invalidated_at INTEGER;

-- Mark all existing trips as invalidated so they show correctly
UPDATE trips SET report_invalidated_at = strftime('%s','now');
