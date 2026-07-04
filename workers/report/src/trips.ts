/**
 * trips.ts — Trip management endpoints for the Routesmith REPORT Worker.
 *
 * Routes:
 *   GET  /api/trips          — List all trips for the authenticated user
 *   POST /api/trips          — Create a new trip
 *   GET  /api/trips/:id      — Get a single trip
 *   PATCH /api/trips/:id     — Update a trip (name, dates, description, distance)
 *   DELETE /api/trips/:id    — Delete a trip
 */

import type { AuthUser } from './auth.js';
import type { Env } from './types.js';

function uuid(): string { return crypto.randomUUID(); }
function now(): number  { return Math.floor(Date.now() / 1000); }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// ============================================================================
// GET /api/trips
// ============================================================================

export async function handleListTrips(user: AuthUser, env: Env): Promise<Response> {
  try {
    const { results } = await env.DB
      .prepare(`
        SELECT trip_id, name, description, status, date_start, date_end,
               distance_miles, distance_hours, gas_cost, created_at, updated_at
        FROM trips
        WHERE user_id = ?
        ORDER BY COALESCE(date_start, '') DESC, created_at DESC
      `)
      .bind(user.userId)
      .all<{
        trip_id: string; name: string; description: string | null;
        status: string; date_start: string | null; date_end: string | null;
        distance_miles: number | null; distance_hours: number | null;
        gas_cost: number | null; created_at: number; updated_at: number;
      }>();

    return jsonResponse({ trips: results });
  } catch (e) {
    return jsonError(`Database error: ${(e as Error).message}`, 500);
  }
}

// ============================================================================
// POST /api/trips
// ============================================================================

interface CreateTripBody {
  name: string;
  description?: string | null;
  date_start?: string | null;
  date_end?: string | null;
  distance_miles?: number | null;
  distance_hours?: number | null;
  gas_cost?: number | null;
}

export async function handleCreateTrip(
  request: Request,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  let body: CreateTripBody;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON body'); }

  if (!body.name?.trim()) return jsonError('name is required');
  if (body.date_start && body.date_end && body.date_start > body.date_end) {
    return jsonError('date_end must be on or after date_start');
  }

  const tripId = uuid();
  const ts     = now();

  // Find the user's default finder
  const finder = await env.DB
    .prepare(`SELECT finder_id FROM finders WHERE owner_user_id = ? AND finder_id = 'finder_' || ?`)
    .bind(user.userId, user.userId)
    .first<{ finder_id: string }>();

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO trips (
          trip_id, user_id, name, description, status,
          date_start, date_end, distance_miles, distance_hours, gas_cost,
          active_finder_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        tripId, user.userId, body.name.trim(),
        body.description ?? null,
        body.date_start ?? null, body.date_end ?? null,
        body.distance_miles ?? null, body.distance_hours ?? null,
        body.gas_cost ?? null,
        finder?.finder_id ?? null,
        ts, ts,
      ),

      // Add owner as the first trip finder
      ...(finder ? [env.DB.prepare(`
        INSERT INTO trip_finders (trip_id, finder_id, role, gpx_mode, uploaded_at)
        VALUES (?, ?, 'owner', 'lifetime', NULL)
      `).bind(tripId, finder.finder_id)] : []),
    ]);

    return jsonResponse({
      trip_id: tripId,
      name: body.name.trim(),
      description: body.description ?? null,
      status: 'draft',
      date_start: body.date_start ?? null,
      date_end: body.date_end ?? null,
      distance_miles: body.distance_miles ?? null,
      distance_hours: body.distance_hours ?? null,
      gas_cost: body.gas_cost ?? null,
      created_at: ts,
      updated_at: ts,
    }, 201);
  } catch (e) {
    return jsonError(`Database error: ${(e as Error).message}`, 500);
  }
}

// ============================================================================
// GET /api/trips/:id
// ============================================================================

export async function handleGetTrip(
  tripId: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  try {
    const trip = await env.DB
      .prepare(`
        SELECT trip_id, name, description, status, date_start, date_end,
               distance_miles, distance_hours, gas_cost,
               active_finder_id, user_notes, created_at, updated_at
        FROM trips
        WHERE trip_id = ? AND user_id = ?
      `)
      .bind(tripId, user.userId)
      .first();

    if (!trip) return jsonError('Trip not found', 404);

    // Also fetch trip finders
    const { results: finders } = await env.DB
      .prepare(`
        SELECT tf.finder_id, tf.role, tf.gpx_mode, tf.find_count,
               f.display_name, f.gc_username, f.color
        FROM trip_finders tf
        JOIN finders f ON f.finder_id = tf.finder_id
        WHERE tf.trip_id = ?
        ORDER BY tf.role DESC
      `)
      .bind(tripId)
      .all();

    return jsonResponse({ ...trip, finders });
  } catch (e) {
    return jsonError(`Database error: ${(e as Error).message}`, 500);
  }
}

// ============================================================================
// PATCH /api/trips/:id
// ============================================================================

export async function handleUpdateTrip(
  tripId: string,
  request: Request,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  let body: Partial<CreateTripBody & { status: string; user_notes: string }>;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON body'); }

  const existing = await env.DB
    .prepare(`SELECT trip_id FROM trips WHERE trip_id = ? AND user_id = ?`)
    .bind(tripId, user.userId)
    .first();
  if (!existing) return jsonError('Trip not found', 404);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined)           { fields.push('name = ?');           values.push(body.name); }
  if (body.description !== undefined)    { fields.push('description = ?');    values.push(body.description); }
  if (body.status !== undefined)         { fields.push('status = ?');         values.push(body.status); }
  if (body.date_start !== undefined)     { fields.push('date_start = ?');     values.push(body.date_start); }
  if (body.date_end !== undefined)       { fields.push('date_end = ?');       values.push(body.date_end); }
  if (body.distance_miles !== undefined) { fields.push('distance_miles = ?'); values.push(body.distance_miles); }
  if (body.distance_hours !== undefined) { fields.push('distance_hours = ?'); values.push(body.distance_hours); }
  if (body.gas_cost !== undefined)       { fields.push('gas_cost = ?');       values.push(body.gas_cost); }
  if (body.user_notes !== undefined)     { fields.push('user_notes = ?');     values.push(body.user_notes); }

  if (!fields.length) return jsonError('No fields to update');

  const ts = now();
  fields.push('updated_at = ?');
  values.push(ts, tripId, user.userId);

  try {
    await env.DB
      .prepare(`UPDATE trips SET ${fields.join(', ')} WHERE trip_id = ? AND user_id = ?`)
      .bind(...values)
      .run();

    return jsonResponse({ trip_id: tripId, updated_at: ts });
  } catch (e) {
    return jsonError(`Database error: ${(e as Error).message}`, 500);
  }
}

// ============================================================================
// DELETE /api/trips/:id
// ============================================================================

export async function handleDeleteTrip(
  tripId: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const existing = await env.DB
    .prepare(`SELECT trip_id FROM trips WHERE trip_id = ? AND user_id = ?`)
    .bind(tripId, user.userId)
    .first();
  if (!existing) return jsonError('Trip not found', 404);

  try {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM trip_finders WHERE trip_id = ?`).bind(tripId),
      env.DB.prepare(`DELETE FROM enabled_rules WHERE trip_id = ?`).bind(tripId),
      env.DB.prepare(`DELETE FROM trip_reports WHERE trip_id = ?`).bind(tripId),
      env.DB.prepare(`DELETE FROM trips WHERE trip_id = ? AND user_id = ?`).bind(tripId, user.userId),
    ]);
    return jsonResponse({ deleted: true });
  } catch (e) {
    return jsonError(`Database error: ${(e as Error).message}`, 500);
  }
}
