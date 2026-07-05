-- =============================================================================
-- Routesmith D1 Schema — Migration 0006
-- finder_finds: full find-level data extracted from My Finds GPX during upload.
-- Powers the trip-window pipeline without needing to re-parse GPX in a Worker.
--
-- Re-finds: same cache found multiple times by same finder is supported via
-- UUID primary key. County coverage always uses earliest find_date.
--
-- Non-public users: if finder_id or other fields are obscured in the GPX,
-- the pipeline handles gracefully — warns the report owner and excludes
-- that companion's data rather than failing.
-- =============================================================================

CREATE TABLE IF NOT EXISTS finder_finds (
    find_id        TEXT PRIMARY KEY,    -- UUID
    finder_id      TEXT NOT NULL REFERENCES finders (finder_id),
    gc_code        TEXT NOT NULL,
    cache_name     TEXT,
    cache_owner    TEXT,                -- groundspeak:owner (cache placer)
    find_date      TEXT NOT NULL,       -- ISO date YYYY-MM-DD
    county         TEXT,
    state          TEXT,
    country        TEXT,
    cache_type     TEXT,
    difficulty     REAL,
    terrain        REAL,
    fav_points     INTEGER NOT NULL DEFAULT 0,
    lat            REAL,
    lon            REAL,
    placement_date TEXT                 -- ISO date YYYY-MM-DD, for Jasmer grid
);

-- Primary lookup: all finds for a finder in a date range (trip window query)
CREATE INDEX IF NOT EXISTS idx_ff_finder_date ON finder_finds (finder_id, find_date);

-- Secondary: find a specific cache find (for dedup during incremental uploads)
CREATE INDEX IF NOT EXISTS idx_ff_finder_gc ON finder_finds (finder_id, gc_code, find_date);
