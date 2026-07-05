/**
 * tripPipeline.ts — Trip-window pipeline endpoint.
 *
 * POST /api/report/trip/:id/run
 *   Queries finder_finds in D1 for the trip date window — no GPX parsing.
 *   Runs stats and rules on the small result set, returns JSON.
 *   Result is cached in trip_reports (D1 + R2).
 *
 * GET /api/report/trip/:id/result
 *   Returns the cached result for the most recent run.
 */

import type { AuthUser } from './auth.js';
import type { Env, Waypoint, RuleContext } from './types.js';
import {
  computePriorData,
  computeAggregateStats,
  computeDailyStats,
  computeMilestones,
  computeJasmerFills,
  computeJasmerGridState,
  computeDtFills,
  computeStateCompletions,
  filterToTripWindow,
  diagnoseEmptyTripWindow,
} from './statistics.js';
import { buildDefaultRules, evaluateAllRules } from './rules.js';
import { buildCountiesData } from './countyMap.js';
import { fetchReferenceListsFromR2, injectReferenceContext } from './referenceLists.js';
import { STATE_ABBREVIATIONS } from './types.js';

function uuid(): string { return crypto.randomUUID(); }
function now(): number  { return Math.floor(Date.now() / 1000); }

function jsonError(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================================
// D1 find row type
// ============================================================================

interface FindRow {
  find_id: string;
  gc_code: string;
  cache_name: string | null;
  cache_owner: string | null;
  find_date: string;
  county: string | null;
  state: string | null;
  country: string | null;
  cache_type: string | null;
  difficulty: number | null;
  terrain: number | null;
  fav_points: number;
  lat: number | null;
  lon: number | null;
  placement_date: string | null;
}

function rowToWaypoint(row: FindRow): Waypoint {
  return {
    gcCode: row.gc_code,
    name: row.cache_name ?? row.gc_code,
    cacheType: row.cache_type,
    lat: row.lat ?? 0,
    lon: row.lon ?? 0,
    container: null,
    difficulty: row.difficulty,
    terrain: row.terrain,
    country: row.country,
    state: row.state,
    county: row.county,
    placementTime: row.placement_date ? new Date(row.placement_date + 'T00:00:00Z') : null,
    findDate: new Date(row.find_date + 'T12:00:00Z'),
    favoritePoints: row.fav_points ?? 0,
    cacheOwner: row.cache_owner,
    attributes: new Set(),
    finderLogText: null,
    sym: null,
    archived: false,
  };
}

// ============================================================================
// POST /api/report/trip/:id/run
// ============================================================================

export async function handleTripRun(
  tripId: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  // Load trip
  const trip = await env.DB
    .prepare(`SELECT * FROM trips WHERE trip_id = ? AND user_id = ?`)
    .bind(tripId, user.userId)
    .first<{
      trip_id: string; name: string; status: string;
      date_start: string | null; date_end: string | null;
      user_notes: string | null; distance_miles: number | null;
      distance_hours: number | null; gas_cost: number | null;
    }>();

  if (!trip) return jsonError('Trip not found', 404);
  if (!trip.date_start || !trip.date_end) return jsonError('Trip must have start and end dates set');

  // Load owner finder
  const ownerFinder = await env.DB
    .prepare(`
      SELECT tf.finder_id, tf.gc_username, tf.display_name,
             f.gc_username as f_gc_username, f.display_name as f_display_name
      FROM trip_finders tf
      JOIN finders f ON f.finder_id = tf.finder_id
      WHERE tf.trip_id = ? AND tf.role = 'owner'
    `)
    .bind(tripId)
    .first<{
      finder_id: string;
      gc_username: string | null; display_name: string | null;
      f_gc_username: string | null; f_display_name: string | null;
    }>();

  if (!ownerFinder) return jsonError('Trip owner finder not found');

  const gcUsername  = ownerFinder.gc_username || ownerFinder.f_gc_username || '';
  const displayName = ownerFinder.display_name || ownerFinder.f_display_name || gcUsername;

  // Check finds are available in D1
  const countCheck = await env.DB
    .prepare(`SELECT COUNT(*) as cnt FROM finder_finds WHERE finder_id = ?`)
    .bind(ownerFinder.finder_id)
    .first<{ cnt: number }>();

  if (!countCheck?.cnt) {
    return jsonError('No find data in database. Re-upload your My Finds GPX on the account page to populate find-level data.');
  }

  // Fetch ALL lifetime finds from D1 (needed for prior county/state/country/type computation)
  const { results: allRows } = await env.DB
    .prepare(`
      SELECT find_id, gc_code, cache_name, cache_owner, find_date,
             county, state, country, cache_type,
             difficulty, terrain, fav_points, lat, lon, placement_date
      FROM finder_finds
      WHERE finder_id = ?
      ORDER BY find_date ASC
    `)
    .bind(ownerFinder.finder_id)
    .all<FindRow>();

  const allFinds = allRows.map(rowToWaypoint);

  const tripStart = new Date(trip.date_start + 'T00:00:00Z');
  const tripEnd   = new Date(trip.date_end   + 'T00:00:00Z');

  // Trip-window filter
  const tripFinds = filterToTripWindow(allFinds, tripStart, tripEnd);

  const diagnostics: string[] = [];
  if (!tripFinds.length && allFinds.length > 0) {
    diagnostics.push(diagnoseEmptyTripWindow(allFinds, tripStart, tripEnd, gcUsername));
  }

  // Statistics
  const { priorCounties, priorStates, priorCountries, priorTypes } =
    computePriorData(allFinds, tripStart);

  const aggregate   = computeAggregateStats(tripFinds, priorCounties, priorStates, priorCountries, priorTypes);
  const byDay       = computeDailyStats(tripFinds, priorCounties, tripStart, tripEnd);
  const milestones  = computeMilestones(allFinds, tripStart, tripEnd);
  const jasmerFills = computeJasmerFills(allFinds, tripStart, tripEnd);
  const dtFills     = computeDtFills(allFinds, tripStart, tripEnd);
  const stateComps  = computeStateCompletions(tripFinds, priorCounties);
  const jasmerGrid  = computeJasmerGridState(allFinds, tripStart, tripEnd);
  const countiesData = buildCountiesData(tripFinds, priorCounties);

  // Rule context
  const ctx: RuleContext = { priorCounties, priorStates, priorCountries, priorTypes };
  for (const [gc, m] of milestones)  (ctx as Record<string, number>)[`milestone_for_${gc}`] = m;
  for (const [gc, c] of jasmerFills) (ctx as Record<string, string>)[`jasmer_fill_${gc}`] = c;
  for (const [gc, c] of dtFills)     (ctx as Record<string, [number, number]>)[`dt_fill_${gc}`] = c;
  for (const [gc, i] of stateComps)  (ctx as Record<string, { state: string; total: number }>)[`state_completion_${gc}`] = i;
  for (const [s, a] of Object.entries(STATE_ABBREVIATIONS)) (ctx as Record<string, string>)[`stateAbbrev_${s}`] = a;

  const refLists = await fetchReferenceListsFromR2(env.REPORT_BUCKET);
  injectReferenceContext(ctx as Record<string, unknown>, refLists);

  const rules = buildDefaultRules();
  const { results: ruleResults, warnings } = evaluateAllRules(tripFinds, rules, ctx);

  const result = {
    trip_id: tripId,
    trip_name: trip.name,
    start_date: trip.date_start,
    end_date: trip.date_end,
    generated_at: now(),
    lifetime_find_count: allFinds.length,
    trip_find_count: tripFinds.length,
    warnings: [...refLists.warnings, ...warnings],
    diagnostics,
    owner: { finder_id: ownerFinder.finder_id, display_name: displayName, gc_username: gcUsername },
    aggregate,
    byDay: byDay.map(ds => ({
      dayDate: ds.dayDate.toISOString().slice(0, 10),
      finds: ds.finds,
      favoritePoints: ds.favoritePoints,
      newCounties: ds.newCounties,
      byCacheType: ds.byCacheType,
      bestFind: ds.bestFind ? {
        gcCode: ds.bestFind.gcCode,
        name: ds.bestFind.name,
        favoritePoints: ds.bestFind.favoritePoints,
        cacheType: ds.bestFind.cacheType,
      } : null,
    })),
    ruleResults: ruleResults.map(rr => ({
      rule: { id: rr.rule.id, displayName: rr.rule.displayName, severity: rr.rule.severity },
      matches: rr.matches.map(m => ({
        gcCode: m.waypoint.gcCode,
        name: m.waypoint.name,
        note: m.note,
        favoritePoints: m.waypoint.favoritePoints,
        cacheType: m.waypoint.cacheType,
        difficulty: m.waypoint.difficulty,
        terrain: m.waypoint.terrain,
        lat: m.waypoint.lat,
        lon: m.waypoint.lon,
        findDate: m.waypoint.findDate?.toISOString().slice(0, 10) ?? null,
      })),
    })),
    countiesData: {
      firstTime: [...countiesData.firstTime],
      previouslyFound: [...countiesData.previouslyFound],
      stateCoverage: countiesData.stateCoverage,
    },
    jasmerGridState: Object.fromEntries(jasmerGrid),
    fieldAvailability: {
      hasCounty: tripFinds.filter(w => w.county).length / Math.max(tripFinds.length, 1) >= 0.1,
      hasFp: tripFinds.filter(w => w.favoritePoints > 0).length / Math.max(tripFinds.length, 1) >= 0.1,
    },
  };

  // Cache result in R2 + D1
  const resultKey = `report-results/${user.userId}/${tripId}/latest.json`;
  const reportId  = uuid();
  const ts        = now();

  try {
    const encoded = new TextEncoder().encode(JSON.stringify(result));
    await env.REPORT_BUCKET.put(resultKey, encoded.buffer as ArrayBuffer, {
      httpMetadata: { contentType: 'application/json' },
    });
    await env.DB.prepare(`
      INSERT INTO trip_reports (report_id, trip_id, generated_at, output_r2_key, field_flags)
      VALUES (?, ?, ?, ?, ?)
    `).bind(reportId, tripId, ts, resultKey, JSON.stringify(result.fieldAvailability)).run();
  } catch { /* non-fatal */ }

  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
}

// ============================================================================
// GET /api/report/trip/:id/result
// ============================================================================

export async function handleTripResult(
  tripId: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const trip = await env.DB
    .prepare(`SELECT trip_id FROM trips WHERE trip_id = ? AND user_id = ?`)
    .bind(tripId, user.userId).first();
  if (!trip) return jsonError('Trip not found', 404);

  const report = await env.DB
    .prepare(`SELECT output_r2_key FROM trip_reports WHERE trip_id = ? ORDER BY generated_at DESC LIMIT 1`)
    .bind(tripId)
    .first<{ output_r2_key: string }>();

  if (!report) return jsonError('No report generated yet', 404);

  const obj = await env.REPORT_BUCKET.get(report.output_r2_key);
  if (!obj) return jsonError('Report result not found in storage', 404);

  return new Response(await obj.text(), { headers: { 'Content-Type': 'application/json' } });
}
