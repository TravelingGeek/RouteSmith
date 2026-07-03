/**
 * account.ts — Account management endpoints for the Routesmith REPORT Worker.
 *
 * Routes:
 *   POST /api/account/sync  — Upsert user row in D1 after sign-in.
 *                             Called once by the frontend after Clerk auth.
 *                             Returns the current user profile.
 *   GET  /api/account/me    — Return the current user profile from D1.
 *
 * Both routes require a valid Clerk JWT (enforced in worker.ts before
 * these handlers are called).
 */

import type { AuthUser } from './auth.js';

export interface Env {
  DB: D1Database;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  bind(...args: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result>;
}

interface D1Result {
  success: boolean;
  meta: { changes: number };
}

// ============================================================================
// POST /api/account/sync
// ============================================================================

/**
 * Upsert the authenticated user into D1.
 * Uses INSERT OR REPLACE so it's safe to call on every sign-in —
 * existing rows are updated if email or display_name changed in Clerk.
 */
export async function handleAccountSync(
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);

  try {
    // Check if user already exists
    const existing = await env.DB
      .prepare('SELECT user_id, created_at FROM users WHERE user_id = ?')
      .bind(user.userId)
      .first<{ user_id: string; created_at: number }>();

    if (existing) {
      // Update mutable fields (can change in Clerk)
      await env.DB
        .prepare(`
          UPDATE users
          SET email = ?, display_name = ?, username = ?, updated_at = ?
          WHERE user_id = ?
        `)
        .bind(user.email, user.displayName, user.username, now, user.userId)
        .run();

      return jsonResponse({
        userId: user.userId,
        email: user.email,
        displayName: user.displayName,
        username: user.username,
        createdAt: existing.created_at,
        updatedAt: now,
        isNewUser: false,
      });
    }

    // New user — insert row
    await env.DB
      .prepare(`
        INSERT INTO users (user_id, email, display_name, username, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(user.userId, user.email, user.displayName, user.username, now, now)
      .run();

    // Also create their default finder record
    // The owner finder uses the same ID pattern as the user for easy lookup
    const finderId = `finder_${user.userId}`;
    await env.DB
      .prepare(`
        INSERT INTO finders (
          finder_id, owner_user_id, gc_username, display_name,
          color, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        finderId,
        user.userId,
        user.username, // pre-fill with Clerk username; user can update in settings
        user.displayName,
        '#1f4068',     // default navy — matches CHART_PRIMARY in charts.ts
        now,
        now,
      )
      .run();

    return jsonResponse({
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      username: user.username,
      createdAt: now,
      updatedAt: now,
      isNewUser: true,
      finderId,
    }, 201);

  } catch (e) {
    return jsonResponse(
      { error: `Database error: ${(e as Error).message}` },
      500,
    );
  }
}

// ============================================================================
// GET /api/account/me
// ============================================================================

/**
 * Return the current user's profile from D1.
 * Returns 404 if the user hasn't synced yet (shouldn't happen in normal flow).
 */
export async function handleAccountMe(
  user: AuthUser,
  env: Env,
): Promise<Response> {
  try {
    const row = await env.DB
      .prepare(`
        SELECT
          u.user_id,
          u.email,
          u.display_name,
          u.created_at,
          u.updated_at,
          f.finder_id,
          f.gc_username,
          f.color,
          f.lifetime_uploaded_at,
          f.lifetime_find_count
        FROM users u
        LEFT JOIN finders f
          ON f.owner_user_id = u.user_id
          AND f.finder_id = 'finder_' || u.user_id
        WHERE u.user_id = ?
      `)
      .bind(user.userId)
      .first<{
        user_id: string;
        email: string;
        display_name: string;
        created_at: number;
        updated_at: number;
        finder_id: string | null;
        gc_username: string | null;
        color: string | null;
        lifetime_uploaded_at: number | null;
        lifetime_find_count: number | null;
      }>();

    if (!row) {
      return jsonResponse({ error: 'User not found. Call /api/account/sync first.' }, 404);
    }

    return jsonResponse({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finder: row.finder_id ? {
        finderId: row.finder_id,
        gcUsername: row.gc_username ?? '',
        color: row.color ?? '#1f4068',
        lifetimeUploadedAt: row.lifetime_uploaded_at,
        lifetimeFindCount: row.lifetime_find_count,
      } : null,
    });

  } catch (e) {
    return jsonResponse(
      { error: `Database error: ${(e as Error).message}` },
      500,
    );
  }
}

// ============================================================================
// Helper
// ============================================================================

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
