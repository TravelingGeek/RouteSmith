-- =============================================================================
-- Routesmith D1 Schema — Migration 0010
-- Normalize cache metadata into its own table.
-- Backfill from existing finder_finds. Keep finder_finds columns for now
-- (rollback safety); a later migration will drop them.
-- =============================================================================

CREATE TABLE IF NOT EXISTS caches (
    gc_code           TEXT PRIMARY KEY,
    name              TEXT,
    cache_type        TEXT,
    container         TEXT,
    difficulty        REAL,
    terrain           REAL,
    lat               REAL,
    lon               REAL,
    county            TEXT,
    state             TEXT,
    country           TEXT,
    county_source     TEXT,   -- 'pgc' | 'pq' | 'geocoded' | 'plan' | NULL
    placement_date    TEXT,
    cache_owner       TEXT,
    fav_points        INTEGER DEFAULT 0,
    status            TEXT DEFAULT 'active',   -- 'active' | 'disabled' | 'archived' | 'unknown'
    last_status_check INTEGER,
    first_seen        INTEGER,
    updated_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_caches_state       ON caches (state);
CREATE INDEX IF NOT EXISTS idx_caches_county      ON caches (county, state);
CREATE INDEX IF NOT EXISTS idx_caches_status_check ON caches (last_status_check);

-- ── Backfill from finder_finds ──────────────────────────────────────────────
-- For each distinct gc_code, take the "best" values across all rows.
-- Priority: non-null county > null. Since PGC uploads populate county and
-- PQ don't, this effectively prefers PGC data during backfill.
-- We set county_source to 'pgc' if county is present (data must have come from
-- a PGC upload), otherwise NULL (will get geocoded later).
INSERT OR IGNORE INTO caches (
  gc_code, name, cache_type, difficulty, terrain, lat, lon,
  county, state, country, county_source,
  placement_date, cache_owner, fav_points, status,
  first_seen, updated_at
)
SELECT
  gc_code,
  MAX(cache_name),
  MAX(cache_type),
  MAX(difficulty),
  MAX(terrain),
  MAX(lat),
  MAX(lon),
  MAX(county),
  MAX(state),
  MAX(country),
  CASE WHEN MAX(county) IS NOT NULL THEN 'pgc' ELSE NULL END,
  MAX(placement_date),
  MAX(cache_owner),
  MAX(fav_points),
  'active',
  strftime('%s','now'),
  strftime('%s','now')
FROM finder_finds
GROUP BY gc_code;
