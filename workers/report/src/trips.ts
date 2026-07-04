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

      // Add owner as the first trip finder — fetch their gc_username and display_name
      ...(finder ? [env.DB.prepare(`
        INSERT INTO trip_finders (trip_id, finder_id, role, gpx_mode, display_name, gc_username, uploaded_at)
        SELECT ?, finder_id, 'owner', 'lifetime', display_name, gc_username, NULL
        FROM finders WHERE finder_id = ?
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

// ============================================================================
// GET /api/trips/:id/companions — List companions on a trip
// ============================================================================

export async function handleListCompanions(
  tripId: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const trip = await env.DB
    .prepare(`SELECT trip_id FROM trips WHERE trip_id = ? AND user_id = ?`)
    .bind(tripId, user.userId).first();
  if (!trip) return jsonError('Trip not found', 404);

  try {
    const { results } = await env.DB
      .prepare(`
        SELECT
          tf.finder_id, tf.role, tf.gpx_mode, tf.find_count,
          tf.display_name, tf.gc_username,
          f.color, f.is_favorite,
          f.lifetime_find_count, f.lifetime_uploaded_at, f.lifetime_data_through
        FROM trip_finders tf
        JOIN finders f ON f.finder_id = tf.finder_id
        WHERE tf.trip_id = ?
        ORDER BY tf.role DESC, f.is_favorite DESC, tf.display_name ASC
      `)
      .bind(tripId)
      .all();
    return jsonResponse({ companions: results });
  } catch (e) {
    return jsonError(`Database error: ${(e as Error).message}`, 500);
  }
}

// ============================================================================
// POST /api/trips/:id/companions — Add a companion to a trip
// ============================================================================

interface AddCompanionBody {
  finder_id?: string;       // existing finder — pick from list
  display_name?: string;    // new finder — create on the fly
  gc_username?: string;
  color?: string;
  gpx_mode?: 'lifetime' | 'diff';
}

export async function handleAddCompanion(
  tripId: string,
  request: Request,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const trip = await env.DB
    .prepare(`SELECT trip_id FROM trips WHERE trip_id = ? AND user_id = ?`)
    .bind(tripId, user.userId).first();
  if (!trip) return jsonError('Trip not found', 404);

  let body: AddCompanionBody;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON body'); }

  const ts = now();
  let finderId: string;
  let displayName: string;
  let gcUsername: string;

  if (body.finder_id) {
    // Existing finder — verify ownership
    const finder = await env.DB
      .prepare(`SELECT finder_id, display_name, gc_username FROM finders WHERE finder_id = ? AND owner_user_id = ?`)
      .bind(body.finder_id, user.userId)
      .first<{ finder_id: string; display_name: string; gc_username: string }>();
    if (!finder) return jsonError('Finder not found', 404);
    finderId    = finder.finder_id;
    displayName = finder.display_name;
    gcUsername  = finder.gc_username;
  } else if (body.display_name) {
    // New finder — create it
    if (!body.gc_username?.trim()) return jsonError('gc_username is required for new companions');
    finderId    = `finder_${body.gc_username.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${uuid().slice(0,8)}`;
    displayName = body.display_name.trim();
    gcUsername  = body.gc_username.trim();

    await env.DB.prepare(`
      INSERT INTO finders (finder_id, owner_user_id, gc_username, display_name, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      finderId, user.userId, gcUsername, displayName,
      body.color ?? '#6b7a8c', ts, ts,
    ).run();
  } else {
    return jsonError('Either finder_id or display_name+gc_username is required');
  }

  // Check not already on trip
  const existing = await env.DB
    .prepare(`SELECT finder_id FROM trip_finders WHERE trip_id = ? AND finder_id = ?`)
    .bind(tripId, finderId).first();
  if (existing) return jsonError('This finder is already on the trip');

  try {
    await env.DB.prepare(`
      INSERT INTO trip_finders (trip_id, finder_id, role, gpx_mode, display_name, gc_username)
      VALUES (?, ?, 'companion', ?, ?, ?)
    `).bind(tripId, finderId, body.gpx_mode ?? 'lifetime', displayName, gcUsername).run();

    return jsonResponse({ finder_id: finderId, display_name: displayName, gc_username: gcUsername }, 201);
  } catch (e) {
    return jsonError(`Database error: ${(e as Error).message}`, 500);
  }
}

// ============================================================================
// DELETE /api/trips/:id/companions/:finder_id — Remove a companion
// ============================================================================

export async function handleRemoveCompanion(
  tripId: string,
  finderId: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const trip = await env.DB
    .prepare(`SELECT trip_id FROM trips WHERE trip_id = ? AND user_id = ?`)
    .bind(tripId, user.userId).first();
  if (!trip) return jsonError('Trip not found', 404);

  // Cannot remove the owner
  const tf = await env.DB
    .prepare(`SELECT role FROM trip_finders WHERE trip_id = ? AND finder_id = ?`)
    .bind(tripId, finderId).first<{ role: string }>();
  if (!tf) return jsonError('Companion not found on this trip', 404);
  if (tf.role === 'owner') return jsonError('Cannot remove the trip owner', 400);

  try {
    await env.DB.prepare(`DELETE FROM trip_finders WHERE trip_id = ? AND finder_id = ?`)
      .bind(tripId, finderId).run();
    return jsonResponse({ deleted: true });
  } catch (e) {
    return jsonError(`Database error: ${(e as Error).message}`, 500);
  }
}

// ============================================================================
// GET /api/finders — List all finders owned by the user (for companion picker)
// ============================================================================

export async function handleListFinders(user: AuthUser, env: Env): Promise<Response> {
  try {
    const { results } = await env.DB
      .prepare(`
        SELECT finder_id, display_name, gc_username, color, is_favorite,
               lifetime_find_count, lifetime_uploaded_at, lifetime_data_through
        FROM finders
        WHERE owner_user_id = ?
        ORDER BY is_favorite DESC, display_name ASC
      `)
      .bind(user.userId)
      .all();
    return jsonResponse({ finders: results });
  } catch (e) {
    return jsonError(`Database error: ${(e as Error).message}`, 500);
  }
}

// ============================================================================
// PATCH /api/finders/:id — Update finder (e.g. toggle is_favorite)
// ============================================================================

export async function handleUpdateFinder(
  finderId: string,
  request: Request,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const finder = await env.DB
    .prepare(`SELECT finder_id FROM finders WHERE finder_id = ? AND owner_user_id = ?`)
    .bind(finderId, user.userId).first();
  if (!finder) return jsonError('Finder not found', 404);

  let body: { is_favorite?: number; display_name?: string; color?: string };
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON body'); }

  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.is_favorite !== undefined) { fields.push('is_favorite = ?'); values.push(body.is_favorite ? 1 : 0); }
  if (body.display_name !== undefined) { fields.push('display_name = ?'); values.push(body.display_name); }
  if (body.color !== undefined) { fields.push('color = ?'); values.push(body.color); }
  if (!fields.length) return jsonError('No fields to update');

  const ts = now();
  fields.push('updated_at = ?');
  values.push(ts, finderId, user.userId);

  try {
    await env.DB.prepare(`UPDATE finders SET ${fields.join(', ')} WHERE finder_id = ? AND owner_user_id = ?`)
      .bind(...values).run();
    return jsonResponse({ finder_id: finderId, updated_at: ts });
  } catch (e) {
    return jsonError(`Database error: ${(e as Error).message}`, 500);
  }
}
