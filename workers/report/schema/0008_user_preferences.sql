-- =============================================================================
-- Routesmith D1 Schema — Migration 0008
-- User preferences: generalized key/value store for per-user settings.
-- Keys are namespaced strings (e.g. 'dashboard.pinned_categories').
-- Values are JSON-encoded strings.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    TEXT NOT NULL REFERENCES users(user_id),
  pref_key   TEXT NOT NULL,
  pref_value TEXT NOT NULL,  -- JSON-encoded value
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, pref_key)
);

-- Seed default preferences for existing users
INSERT OR IGNORE INTO user_preferences (user_id, pref_key, pref_value, updated_at)
SELECT user_id,
       'dashboard.pinned_categories',
       '["counties","highlights"]',
       strftime('%s', 'now')
FROM users;

INSERT OR IGNORE INTO user_preferences (user_id, pref_key, pref_value, updated_at)
SELECT user_id,
       'dashboard.animations_enabled',
       'true',
       strftime('%s', 'now')
FROM users;
