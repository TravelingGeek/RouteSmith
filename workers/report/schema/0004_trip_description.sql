-- =============================================================================
-- Routesmith D1 Schema — Migration 0004
-- Add description column to trips table
-- =============================================================================

ALTER TABLE trips ADD COLUMN description TEXT;
