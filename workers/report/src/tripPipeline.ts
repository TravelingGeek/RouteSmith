/**
 * tripPipeline.ts — Trip-window pipeline using targeted D1 queries.
 *
 * Instead of loading all lifetime finds into memory, uses targeted D1 queries:
 * - Trip-window finds: full data, small set (~200 rows for a week trip)
 * - Prior data: aggregated DISTINCT values, not individual rows
 * - Milestone/Jasmer: only gc_code + find_date + placement_date
 */

import type { AuthUser } from './auth.js';
import type { Env, Waypoint, RuleContext } from './types.js';
import {
  computeAggregateStats,
  computeDailyStats,
  computeMilestones,
  computeJasmerFills,
  computeJasmerGridState,
  computeDtFills,
  computeStateCompletions,
  filterToTripWindow,
} from './statistics.js';
import { buildDefaultRules, evaluateAllRules } from './rules.js';
import { buildCountiesData } from './countyMap.js';
import { fetchReferenceListsFromR2, injectReferenceContext } from './referenceLists.js';
import { countyKey, STATE_ABBREVIATIONS } from './types.js';

function uuid(): string { return crypto.randomUUID(); }
function now(): number  { return Math.floor(Date.now() / 1000); }

function jsonError(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json' } });
}

interface FindRow {
  find_id: string; gc_code: string; cache_name: string | null;
  cache_owner: string | null; find_date: string;
  county: string | null; state: string | null; country: string | null;
  cache_type: string | null; difficulty: number | null; terrain: number | null;
  fav_points: number; lat: number | null; lon: number | null;
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
      finder_id: string; gc_username: string | null; display_name: string | null;
      f_gc_username: string | null; f_display_name: string | null;
    }>();

  if (!ownerFinder) return jsonError('Trip owner finder not found');

  const finderId    = ownerFinder.finder_id;
  const gcUsername  = ownerFinder.gc_username || ownerFinder.f_gc_username || '';
  const displayName = ownerFinder.display_name || ownerFinder.f_display_name || gcUsername;
  const tripStart   = trip.date_start;
  const tripEnd     = trip.date_end;

  // ── Check finds available ─────────────────────────────────────────────────
  const countCheck = await env.DB
    .prepare(`SELECT COUNT(*) as cnt FROM finder_finds WHERE finder_id = ?`)
    .bind(finderId)
    .first<{ cnt: number }>();

  if (!countCheck?.cnt) {
    return jsonError('No find data in database. Re-upload your My Finds GPX on the account page.');
  }

  // ── Query 1: Trip-window finds (full data — small set) ────────────────────
  const { results: tripRows } = await env.DB
    .prepare(`
      SELECT find_id, gc_code, cache_name, cache_owner, find_date,
             county, state, country, cache_type,
             difficulty, terrain, fav_points, lat, lon, placement_date
      FROM finder_finds
      WHERE finder_id = ? AND find_date >= ? AND find_date <= ?
      ORDER BY find_date ASC
    `)
    .bind(finderId, tripStart, tripEnd)
    .all<FindRow>();

  const tripFinds = tripRows.map(rowToWaypoint);

  // ── Query 2: Prior counties (DISTINCT — memory-efficient) ─────────────────
  const { results: priorCountyRows } = await env.DB
    .prepare(`
      SELECT DISTINCT county, state FROM finder_finds
      WHERE finder_id = ? AND find_date < ? AND county IS NOT NULL AND state IS NOT NULL
    `)
    .bind(finderId, tripStart)
    .all<{ county: string; state: string }>();

  const priorCounties = new Set(priorCountyRows.map(r => countyKey(r.county, r.state)));

  // ── Query 3: Prior states ─────────────────────────────────────────────────
  const { results: priorStateRows } = await env.DB
    .prepare(`
      SELECT DISTINCT state FROM finder_finds
      WHERE finder_id = ? AND find_date < ? AND state IS NOT NULL
    `)
    .bind(finderId, tripStart)
    .all<{ state: string }>();

  const priorStates = new Set(priorStateRows.map(r => r.state));

  // ── Query 4: Prior countries ──────────────────────────────────────────────
  const { results: priorCountryRows } = await env.DB
    .prepare(`
      SELECT DISTINCT country FROM finder_finds
      WHERE finder_id = ? AND find_date < ? AND country IS NOT NULL
    `)
    .bind(finderId, tripStart)
    .all<{ country: string }>();

  const priorCountries = new Set(priorCountryRows.map(r => r.country));

  // ── Query 5: Prior cache types ────────────────────────────────────────────
  const { results: priorTypeRows } = await env.DB
    .prepare(`
      SELECT DISTINCT cache_type FROM finder_finds
      WHERE finder_id = ? AND find_date < ? AND cache_type IS NOT NULL
    `)
    .bind(finderId, tripStart)
    .all<{ cache_type: string }>();

  const priorTypes = new Set(priorTypeRows.map(r => r.cache_type));

  // ── Query 6: Lifetime finds for milestone/Jasmer (minimal fields) ─────────
  const { results: lifetimeRows } = await env.DB
    .prepare(`
      SELECT gc_code, find_date, placement_date, cache_type, difficulty, terrain
      FROM finder_finds
      WHERE finder_id = ?
      ORDER BY find_date ASC
    `)
    .bind(finderId)
    .all<{ gc_code: string; find_date: string; placement_date: string | null; cache_type: string | null; difficulty: number | null; terrain: number | null }>();

  // Minimal Waypoint objects for milestone/Jasmer computation
  const lifetimeMinimal: Waypoint[] = lifetimeRows.map(r => ({
    gcCode: r.gc_code,
    name: r.gc_code,
    cacheType: r.cache_type,
    lat: 0, lon: 0, container: null,
    difficulty: r.difficulty, terrain: r.terrain,
    country: null, state: null, county: null,
    placementTime: r.placement_date ? new Date(r.placement_date + 'T00:00:00Z') : null,
    findDate: new Date(r.find_date + 'T12:00:00Z'),
    favoritePoints: 0, cacheOwner: null,
    attributes: new Set(), finderLogText: null, sym: null, archived: false,
  }));

  const tripStartDate = new Date(tripStart + 'T00:00:00Z');
  const tripEndDate   = new Date(tripEnd   + 'T00:00:00Z');

  // ── Statistics ────────────────────────────────────────────────────────────
  const diagnostics: string[] = [];
  if (!tripFinds.length) {
    diagnostics.push(`No finds found between ${tripStart} and ${tripEnd} for ${gcUsername}. Check that your GPX data covers this date range.`);
  }

  const aggregate   = computeAggregateStats(tripFinds, priorCounties, priorStates, priorCountries, priorTypes);
  const byDay       = computeDailyStats(tripFinds, priorCounties, tripStartDate, tripEndDate);
  const milestones  = computeMilestones(lifetimeMinimal, tripStartDate, tripEndDate);
  const jasmerFills = computeJasmerFills(lifetimeMinimal, tripStartDate, tripEndDate);
  const dtFills     = computeDtFills(lifetimeMinimal, tripStartDate, tripEndDate);
  const stateComps  = computeStateCompletions(tripFinds, priorCounties);
  const jasmerGrid  = computeJasmerGridState(lifetimeMinimal, tripStartDate, tripEndDate);
  const countiesData = buildCountiesData(tripFinds, priorCounties);

  // ── Rules ─────────────────────────────────────────────────────────────────
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

  // ── Serialize result ──────────────────────────────────────────────────────
  const result = {
    trip_id: tripId,
    trip_name: trip.name,
    start_date: tripStart,
    end_date: tripEnd,
    generated_at: now(),
    lifetime_find_count: lifetimeRows.length,
    trip_find_count: tripFinds.length,
    warnings: [...refLists.warnings, ...warnings],
    diagnostics,
    owner: { finder_id: finderId, display_name: displayName, gc_username: gcUsername },
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

  // ── Cache result ──────────────────────────────────────────────────────────
  const resultKey = `report-results/${user.userId}/${tripId}/latest.json`;
  const ts = now();
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(result));
    await env.REPORT_BUCKET.put(resultKey, encoded.buffer as ArrayBuffer, {
      httpMetadata: { contentType: 'application/json' },
    });
    await env.DB.prepare(`
      INSERT INTO trip_reports (report_id, trip_id, generated_at, output_r2_key, field_flags)
      VALUES (?, ?, ?, ?, ?)
    `).bind(uuid(), tripId, ts, resultKey, JSON.stringify(result.fieldAvailability)).run();
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
