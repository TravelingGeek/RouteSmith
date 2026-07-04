-- =============================================================================
-- Routesmith D1 Schema — Migration 0005
-- Add is_favorite to finders; add companion name/username to trip_finders
-- =============================================================================

-- Favorite flag on finders — starred companions surface at top of picker
ALTER TABLE finders ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;

-- Store companion display info on trip_finders for denormalized display
-- (avoids a join when listing trip companions)
ALTER TABLE trip_finders ADD COLUMN display_name TEXT;
ALTER TABLE trip_finders ADD COLUMN gc_username  TEXT;
