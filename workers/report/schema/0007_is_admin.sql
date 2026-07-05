-- =============================================================================
-- Routesmith D1 Schema — Migration 0007
-- Add is_admin flag to users table.
-- Authorization (not authentication) — Clerk handles auth, we handle authz.
-- =============================================================================

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- Grant admin to TravelingGeek
UPDATE users SET is_admin = 1 WHERE user_id = 'user_3FzoQDubzX7ouXjWlujcinBxaIs';
