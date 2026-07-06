/**
 * preferences.ts — User preferences endpoints.
 *
 * GET  /api/preferences         — Get all preferences for the current user
 * GET  /api/preferences/:key    — Get a single preference
 * PUT  /api/preferences/:key    — Set a preference value
 * DELETE /api/preferences/:key  — Reset a preference to default
 */

import type { AuthUser } from './auth.js';
import type { Env } from './types.js';

function now(): number { return Math.floor(Date.now() / 1000); }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
function jsonError(msg: string, status = 400): Response {
  return jsonResponse({ error: msg }, status);
}

// Allowed preference keys and their defaults
const PREF_DEFAULTS: Record<string, unknown> = {
  'dashboard.pinned_categories':  ['counties', 'highlights'],
  'dashboard.animations_enabled': true,
  'dashboard.default_category':   'counties',
  'dashboard.default_sub':        'map',
};

function isAllowedKey(key: string): boolean {
  return key in PREF_DEFAULTS;
}

// ============================================================================
// GET /api/preferences
// ============================================================================

export async function handleGetPreferences(
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const { results } = await env.DB
    .prepare(`SELECT pref_key, pref_value FROM user_preferences WHERE user_id = ?`)
    .bind(user.userId)
    .all<{ pref_key: string; pref_value: string }>();

  // Build response with stored values merged over defaults
  const prefs: Record<string, unknown> = { ...PREF_DEFAULTS };
  for (const row of results) {
    try { prefs[row.pref_key] = JSON.parse(row.pref_value); }
    catch { prefs[row.pref_key] = row.pref_value; }
  }

  return jsonResponse({ preferences: prefs });
}

// ============================================================================
// GET /api/preferences/:key
// ============================================================================

export async function handleGetPreference(
  key: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  if (!isAllowedKey(key)) return jsonError(`Unknown preference key: ${key}`, 404);

  const row = await env.DB
    .prepare(`SELECT pref_value FROM user_preferences WHERE user_id = ? AND pref_key = ?`)
    .bind(user.userId, key)
    .first<{ pref_value: string }>();

  const value = row
    ? (() => { try { return JSON.parse(row.pref_value); } catch { return row.pref_value; } })()
    : PREF_DEFAULTS[key];

  return jsonResponse({ key, value });
}

// ============================================================================
// PUT /api/preferences/:key
// ============================================================================

export async function handleSetPreference(
  key: string,
  request: Request,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  if (!isAllowedKey(key)) return jsonError(`Unknown preference key: ${key}`, 404);

  let body: { value: unknown };
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON body'); }

  if (body.value === undefined) return jsonError('value is required');

  const ts = now();
  await env.DB
    .prepare(`
      INSERT INTO user_preferences (user_id, pref_key, pref_value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, pref_key) DO UPDATE SET
        pref_value = excluded.pref_value,
        updated_at = excluded.updated_at
    `)
    .bind(user.userId, key, JSON.stringify(body.value), ts)
    .run();

  return jsonResponse({ key, value: body.value, updated_at: ts });
}

// ============================================================================
// DELETE /api/preferences/:key  — reset to default
// ============================================================================

export async function handleDeletePreference(
  key: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  if (!isAllowedKey(key)) return jsonError(`Unknown preference key: ${key}`, 404);

  await env.DB
    .prepare(`DELETE FROM user_preferences WHERE user_id = ? AND pref_key = ?`)
    .bind(user.userId, key)
    .run();

  return jsonResponse({ key, value: PREF_DEFAULTS[key], reset: true });
}
