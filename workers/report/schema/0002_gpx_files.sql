-- =============================================================================
-- Routesmith D1 Schema — Migration 0002
-- GPX file tracking, authorization model, and audit history
-- =============================================================================

-- -----------------------------------------------------------------------------
-- finders — add lifetime data freshness column
-- -----------------------------------------------------------------------------
ALTER TABLE finders ADD COLUMN lifetime_data_through TEXT;
-- ISO date "YYYY-MM-DD" of the most recent find in the lifetime GPX.
-- NULL until a lifetime GPX has been parsed.
-- Displayed as: "Data current through {date} · {count} finds"

-- -----------------------------------------------------------------------------
-- gpx_files
-- One row per GPX file stored in R2. Owned by a finder but uploaded by a user.
-- A finder may have many GPX files over time as they upload newer exports.
-- Only one file per (finder_id, file_role) is "active" at a time;
-- superseded files are marked inactive but retained until explicitly deleted.
--
-- file_role: 'lifetime' | 'before' | 'after'
--   lifetime — full My Finds export (PGC or gc.com)
--   before   — pre-trip snapshot (diff mode companions)
--   after    — post-trip snapshot (diff mode companions)
--
-- uploaded_by_user_id: the Routesmith user who performed the upload.
--   For the owner finder this is always their own user_id.
--   For companion finders this is the trip owner's user_id.
--
-- owner_finder_id: the finder whose find history this file represents.
--
-- scope: 'full' | 'incremental'
--   Mirrors PGC's weekly full vs. daily incremental distinction.
--   gc.com PQ exports are always 'full'.
--
-- is_active: 1 if this is the current file for this finder+role.
--   Set to 0 when superseded by a newer upload or explicitly deleted.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gpx_files (
    gpx_file_id         TEXT PRIMARY KEY,   -- UUID
    owner_finder_id     TEXT NOT NULL REFERENCES finders (finder_id),
    uploaded_by_user_id TEXT NOT NULL REFERENCES users (user_id),
    file_role           TEXT NOT NULL DEFAULT 'lifetime', -- lifetime | before | after
    scope               TEXT NOT NULL DEFAULT 'full',     -- full | incremental
    r2_key              TEXT NOT NULL UNIQUE,
    find_count          INTEGER,            -- populated after parse; NULL until parsed
    data_through        TEXT,               -- ISO date of newest find; NULL until parsed
    format              TEXT,               -- 'pgc' | 'gccom' | 'unknown'
    file_size_bytes     INTEGER,
    is_active           INTEGER NOT NULL DEFAULT 1,  -- SQLite boolean
    uploaded_at         INTEGER NOT NULL,   -- Unix epoch seconds
    parsed_at           INTEGER,            -- NULL until pipeline has processed it
    deleted_at          INTEGER,            -- NULL until deleted
    deleted_by_user_id  TEXT REFERENCES users (user_id)
);

CREATE INDEX IF NOT EXISTS idx_gpxf_finder      ON gpx_files (owner_finder_id, file_role, is_active);
CREATE INDEX IF NOT EXISTS idx_gpxf_uploader    ON gpx_files (uploaded_by_user_id);
CREATE INDEX IF NOT EXISTS idx_gpxf_r2_key      ON gpx_files (r2_key);

-- -----------------------------------------------------------------------------
-- gpx_file_trip_auth
-- Explicit authorization: which trips are permitted to use which GPX files.
-- A file uploaded for a specific trip is authorized only for that trip by
-- default. The trip owner can extend authorization to additional trips later.
--
-- authorized_by_user_id: always the Routesmith user who granted access.
--   For the initial upload this is the uploader. For extended access this
--   is whoever granted the extension.
--
-- This table is the authorization enforcement boundary. In v1 it is
-- populated but not yet enforced at query time. Enforcement is added in v2
-- when multi-user sharing and companion accounts are introduced.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gpx_file_trip_auth (
    gpx_file_id             TEXT NOT NULL REFERENCES gpx_files (gpx_file_id),
    trip_id                 TEXT NOT NULL REFERENCES trips (trip_id),
    authorized_by_user_id   TEXT NOT NULL REFERENCES users (user_id),
    authorized_at           INTEGER NOT NULL,   -- Unix epoch seconds
    PRIMARY KEY (gpx_file_id, trip_id)
);

CREATE INDEX IF NOT EXISTS idx_gfta_file ON gpx_file_trip_auth (gpx_file_id);
CREATE INDEX IF NOT EXISTS idx_gfta_trip ON gpx_file_trip_auth (trip_id);

-- -----------------------------------------------------------------------------
-- gpx_file_events
-- Immutable audit log. One row per event. Never updated or deleted.
--
-- event_type:
--   'uploaded'          — file arrived in R2 and row created in gpx_files
--   'parsed'            — pipeline processed the file; find_count and
--                         data_through populated
--   'replaced'          — a newer upload superseded this file;
--                         executed_by_user_id is the user who uploaded
--                         the replacement (triggering the implicit deletion)
--   'deleted_by_request' — user explicitly requested deletion
--   'auth_granted'      — trip authorization added
--   'auth_revoked'      — trip authorization removed (future)
--
-- executed_by_user_id: the Routesmith user whose action caused this event.
--   Always populated — every event has a human actor.
--
-- related_gpx_file_id: for 'replaced' events, the new file that triggered
--   the replacement. NULL for all other event types.
--
-- note: free-text field for additional context (e.g. "Replaced by upload
--   of myfinds-2089726.zip on 2026-07-03").
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gpx_file_events (
    event_id                TEXT PRIMARY KEY,   -- UUID
    gpx_file_id             TEXT NOT NULL REFERENCES gpx_files (gpx_file_id),
    event_type              TEXT NOT NULL,
    executed_by_user_id     TEXT NOT NULL REFERENCES users (user_id),
    related_gpx_file_id     TEXT REFERENCES gpx_files (gpx_file_id),
    related_trip_id         TEXT REFERENCES trips (trip_id),
    note                    TEXT,
    occurred_at             INTEGER NOT NULL    -- Unix epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_gfe_file     ON gpx_file_events (gpx_file_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_gfe_executor ON gpx_file_events (executed_by_user_id);
CREATE INDEX IF NOT EXISTS idx_gfe_type     ON gpx_file_events (event_type);

-- -----------------------------------------------------------------------------
-- trip_finders — add gpx_file_id foreign keys
-- Links trip_finders rows to the specific gpx_files records in use,
-- replacing the raw R2 key strings from migration 0001.
-- The raw key columns are retained for now and will be dropped in a
-- future migration once the gpx_files table is the source of truth.
-- -----------------------------------------------------------------------------
ALTER TABLE trip_finders ADD COLUMN gpx_file_id      TEXT REFERENCES gpx_files (gpx_file_id);
ALTER TABLE trip_finders ADD COLUMN before_file_id   TEXT REFERENCES gpx_files (gpx_file_id);
ALTER TABLE trip_finders ADD COLUMN after_file_id    TEXT REFERENCES gpx_files (gpx_file_id);
