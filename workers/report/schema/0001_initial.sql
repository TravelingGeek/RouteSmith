-- =============================================================================
-- Routesmith D1 Schema — Migration 0001
-- SQLite / Cloudflare D1
--
-- Design decisions:
--   - UUIDs stored as TEXT (D1 has no native UUID type)
--   - Timestamps stored as INTEGER (Unix epoch seconds) for easy comparison
--   - County keys stored as "county|state" TEXT (matches countyKey() in types.ts)
--   - No JSON columns — structured data is normalized into tables
--   - Soft deletes not used in v1; rows are hard-deleted
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users
-- One row per Clerk user. Created on first authenticated request.
-- clerk_user_id is the `sub` claim from the Clerk JWT.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    user_id         TEXT PRIMARY KEY,   -- Clerk user ID (e.g. user_2abc...)
    email           TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    created_at      INTEGER NOT NULL,   -- Unix epoch seconds
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- -----------------------------------------------------------------------------
-- finders
-- One row per geocaching identity that has data in the system.
-- The trip owner is always a finder. Companions are also finders,
-- but owned by the user who uploaded their data.
--
-- owner_user_id: the Routesmith user who uploaded this finder's data.
-- gc_username: geocaching.com username (used for GPX log matching).
-- color: hex color for map/chart display (e.g. "#e8a838").
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finders (
    finder_id               TEXT PRIMARY KEY,   -- UUID
    owner_user_id           TEXT NOT NULL REFERENCES users (user_id),
    gc_username             TEXT NOT NULL,
    display_name            TEXT NOT NULL,
    color                   TEXT NOT NULL DEFAULT '#1f4068',
    lifetime_uploaded_at    INTEGER,            -- Unix epoch; NULL if never uploaded
    lifetime_find_count     INTEGER,            -- NULL if never uploaded
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_finders_owner ON finders (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_finders_gc_username ON finders (gc_username COLLATE NOCASE);

-- -----------------------------------------------------------------------------
-- finder_county_lifetime
-- Per-finder county coverage derived from their lifetime finds export.
-- Populated when the user uploads a My Finds GPX.
-- Status (new vs. returning) is always derived at query time by comparing
-- first_found against the trip date range — never stored.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finder_county_lifetime (
    finder_id   TEXT NOT NULL REFERENCES finders (finder_id),
    county_key  TEXT NOT NULL,  -- "county|state" e.g. "Cook County|Illinois"
    state       TEXT NOT NULL,
    county      TEXT NOT NULL,
    country     TEXT NOT NULL DEFAULT 'United States',
    first_found INTEGER NOT NULL,   -- Unix epoch seconds of first find in this county
    PRIMARY KEY (finder_id, county_key)
);

CREATE INDEX IF NOT EXISTS idx_fcl_finder ON finder_county_lifetime (finder_id);
CREATE INDEX IF NOT EXISTS idx_fcl_state  ON finder_county_lifetime (finder_id, state);

-- -----------------------------------------------------------------------------
-- trips
-- One row per geocaching trip. Belongs to a user (the trip owner).
-- The active_finder_id is the "switch focus" selection — defaults to the
-- owner's finder_id but can be changed to any companion finder.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
    trip_id             TEXT PRIMARY KEY,   -- UUID
    user_id             TEXT NOT NULL REFERENCES users (user_id),
    name                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'draft',  -- draft | active | complete
    date_start          TEXT,               -- ISO date "YYYY-MM-DD"; NULL until set
    date_end            TEXT,               -- ISO date "YYYY-MM-DD"; NULL until set
    active_finder_id    TEXT REFERENCES finders (finder_id),
    distance_miles      REAL,
    distance_hours      REAL,
    gas_cost            REAL,
    user_notes          TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trips_user ON trips (user_id);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips (user_id, status);

-- -----------------------------------------------------------------------------
-- trip_finders
-- Which finders are on a trip. The owner finder is always included.
-- Companions are added by the trip owner uploading their GPX data.
-- role: 'owner' | 'companion'
-- gpx_r2_key: R2 key for this finder's lifetime GPX on this trip (nullable
--   until uploaded; companions may use before/after mode instead).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_finders (
    trip_id         TEXT NOT NULL REFERENCES trips (trip_id),
    finder_id       TEXT NOT NULL REFERENCES finders (finder_id),
    role            TEXT NOT NULL DEFAULT 'companion',  -- owner | companion
    gpx_mode        TEXT NOT NULL DEFAULT 'lifetime',   -- lifetime | diff
    gpx_r2_key      TEXT,   -- R2 key for lifetime GPX (lifetime mode)
    before_r2_key   TEXT,   -- R2 key for before-snapshot GPX (diff mode)
    after_r2_key    TEXT,   -- R2 key for after-snapshot GPX (diff mode)
    uploaded_at     INTEGER,    -- NULL until GPX is uploaded
    find_count      INTEGER,    -- populated after GPX is parsed
    PRIMARY KEY (trip_id, finder_id)
);

CREATE INDEX IF NOT EXISTS idx_tf_trip   ON trip_finders (trip_id);
CREATE INDEX IF NOT EXISTS idx_tf_finder ON trip_finders (finder_id);

-- -----------------------------------------------------------------------------
-- trip_reports
-- One row per generated report. A trip can have multiple reports
-- (e.g. regenerated after adding a companion).
-- output_r2_key: R2 key for the stored HTML report (nullable until generated).
-- snapshot_json: serialized PipelineResult for dashboard re-hydration
--   without re-running the pipeline (stored as TEXT / JSON string).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_reports (
    report_id       TEXT PRIMARY KEY,   -- UUID
    trip_id         TEXT NOT NULL REFERENCES trips (trip_id),
    generated_at    INTEGER NOT NULL,
    output_r2_key   TEXT,               -- R2 key for the HTML report file
    snapshot_json   TEXT,               -- JSON string of PipelineResult
    field_flags     TEXT NOT NULL DEFAULT '{}' -- JSON: { hasCounty, hasFp }
);

CREATE INDEX IF NOT EXISTS idx_tr_trip ON trip_reports (trip_id, generated_at DESC);

-- -----------------------------------------------------------------------------
-- enabled_rules
-- Per-trip rule enable/disable overrides. If no rows exist for a trip,
-- all default rules are enabled (matches Python behavior of empty enabled_rules).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enabled_rules (
    trip_id     TEXT NOT NULL REFERENCES trips (trip_id),
    rule_id     TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,  -- SQLite boolean: 1 = true
    PRIMARY KEY (trip_id, rule_id)
);
