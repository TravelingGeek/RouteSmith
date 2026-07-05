/**
 * tripPipeline.ts — Trip-window pipeline endpoint.
 *
 * POST /api/report/trip/:id/run
 *   Fetches the owner's active GPX files from R2, parses to waypoints,
 *   filters to the trip date window, runs stats and rules, returns JSON.
 *   Result is cached in trip_reports (D1 + R2).
 *
 * GET /api/report/trip/:id/result
 *   Returns the cached result for the most recent run.
 *
 * Solo trips only in v1. Multi-finder deferred pending memory solution.
 */

import type { AuthUser } from './auth.js';
import type { Env } from './types.js';
import { parseGpxTextAsync } from './gpxParser.js';
import { unzipSync } from 'fflate';
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
import { fetchReferenceListsFromR2 } from './referenceLists.js';
import { injectReferenceContext } from './referenceLists.js';
import type { Waypoint, RuleContext, TripInput } from './types.js';
import { STATE_ABBREVIATIONS } from './types.js';

function uuid(): string  { return crypto.randomUUID(); }
function now(): number   { return Math.floor(Date.now() / 1000); }
function jsonError(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json' } });
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
      SELECT tf.finder_id, tf.gc_username, tf.display_name, f.gc_username as f_gc_username
      FROM trip_finders tf
      JOIN finders f ON f.finder_id = tf.finder_id
      WHERE tf.trip_id = ? AND tf.role = 'owner'
    `)
    .bind(tripId)
    .first<{ finder_id: string; gc_username: string | null; display_name: string | null; f_gc_username: string | null }>();

  if (!ownerFinder) return jsonError('Trip owner finder not found');

  const gcUsername = ownerFinder.gc_username || ownerFinder.f_gc_username || '';

  // Load active GPX files for the owner finder
  const { results: gpxFiles } = await env.DB
    .prepare(`
      SELECT gpx_file_id, r2_key, scope, file_role
      FROM gpx_files
      WHERE owner_finder_id = ? AND is_active = 1 AND deleted_at IS NULL
        AND file_role = 'lifetime'
      ORDER BY scope ASC
    `)
    .bind(ownerFinder.finder_id)
    .all<{ gpx_file_id: string; r2_key: string; scope: string; file_role: string }>();

  if (!gpxFiles.length) return jsonError('No lifetime GPX data found. Upload your My Finds GPX on the account page.');

  // Fetch and parse GPX files — sequential to minimize memory
  const tripStart = new Date(trip.date_start + 'T00:00:00Z');
  const tripEnd   = new Date(trip.date_end   + 'T00:00:00Z');
  const seen = new Map<string, Waypoint>();

  for (const gpxFile of gpxFiles) {
    const obj = await env.REPORT_BUCKET.get(gpxFile.r2_key);
    if (!obj) continue;

    const buffer = await obj.arrayBuffer();
    let texts: string[];

    if (gpxFile.r2_key.toLowerCase().endsWith('.zip')) {
      const files = unzipSync(new Uint8Array(buffer));
      const entries = Object.entries(files).filter(
        ([n]) => n.toLowerCase().endsWith('.gpx') && !n.toLowerCase().includes('wpts')
      );
      const decoder = new TextDecoder('utf-8');
      texts = entries.map(([, d]) => decoder.decode(d));
    } else {
      texts = [new TextDecoder('utf-8').decode(buffer)];
    }

    for (const text of texts) {
      const waypoints = await parseGpxTextAsync(text, gcUsername);
      for (const w of waypoints) seen.set(w.gcCode, w);
    }
  }

  const allFinds = Array.from(seen.values());

  if (!allFinds.length) {
    return jsonError('No finds parsed from GPX files. Check that your GPX is a valid My Finds export.');
  }

  // Trip-window filter
  const tripFinds = filterToTripWindow(allFinds, tripStart, tripEnd);

  const diagnostics: string[] = [];
  if (!tripFinds.length) {
    diagnostics.push(diagnoseEmptyTripWindow(allFinds, tripStart, tripEnd, gcUsername));
  }

  // Statistics
  const { priorCounties, priorStates, priorCountries, priorTypes } =
    computePriorData(allFinds, tripStart);

  const aggregate  = computeAggregateStats(tripFinds, priorCounties, priorStates, priorCountries, priorTypes);
  const byDay      = computeDailyStats(tripFinds, priorCounties, tripStart, tripEnd);
  const milestones = computeMilestones(allFinds, tripStart, tripEnd);
  const jasmerFills = computeJasmerFills(allFinds, tripStart, tripEnd);
  const dtFills    = computeDtFills(allFinds, tripStart, tripEnd);
  const stateComps = computeStateCompletions(tripFinds, priorCounties);
  const jasmerGrid = computeJasmerGridState(allFinds, tripStart, tripEnd);
  const countiesData = buildCountiesData(tripFinds, priorCounties);

  // Rule context
  const ctx: RuleContext = { priorCounties, priorStates, priorCountries, priorTypes };
  for (const [gc, m] of milestones) (ctx as Record<string, number>)[`milestone_for_${gc}`] = m;
  for (const [gc, c] of jasmerFills) (ctx as Record<string, string>)[`jasmer_fill_${gc}`] = c;
  for (const [gc, c] of dtFills) (ctx as Record<string, [number, number]>)[`dt_fill_${gc}`] = c;
  for (const [gc, i] of stateComps) (ctx as Record<string, { state: string; total: number }>)[`state_completion_${gc}`] = i;
  for (const [s, a] of Object.entries(STATE_ABBREVIATIONS)) (ctx as Record<string, string>)[`stateAbbrev_${s}`] = a;

  const refLists = await fetchReferenceListsFromR2(env.REPORT_BUCKET);
  injectReferenceContext(ctx as Record<string, unknown>, refLists);

  const rules = buildDefaultRules();
  const { results: ruleResults, warnings } = evaluateAllRules(tripFinds, rules, ctx);

  // Serialize result
  const result = {
    trip_id: tripId,
    trip_name: trip.name,
    start_date: trip.date_start,
    end_date: trip.date_end,
    generated_at: now(),
    find_count: allFinds.length,
    trip_find_count: tripFinds.length,
    warnings: [...refLists.warnings, ...warnings],
    diagnostics,
    owner: {
      finder_id: ownerFinder.finder_id,
      display_name: ownerFinder.display_name ?? gcUsername,
      gc_username: gcUsername,
    },
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
      rule: { id: rr.rule.id, displayName: rr.rule.displayName, severity: rr.rule.severity, description: rr.rule.description },
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

  // Store result in R2 and D1
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
  } catch {
    // Non-fatal — return result even if caching fails
  }

  return jsonResponse(result);
}

// ============================================================================
// GET /api/report/trip/:id/result
// ============================================================================

export async function handleTripResult(
  tripId: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  // Verify trip ownership
  const trip = await env.DB
    .prepare(`SELECT trip_id FROM trips WHERE trip_id = ? AND user_id = ?`)
    .bind(tripId, user.userId).first();
  if (!trip) return jsonError('Trip not found', 404);

  // Get most recent report
  const report = await env.DB
    .prepare(`
      SELECT output_r2_key FROM trip_reports
      WHERE trip_id = ? ORDER BY generated_at DESC LIMIT 1
    `)
    .bind(tripId)
    .first<{ output_r2_key: string }>();

  if (!report) return jsonError('No report generated yet. Run the pipeline first.', 404);

  const obj = await env.REPORT_BUCKET.get(report.output_r2_key);
  if (!obj) return jsonError('Report result not found in storage', 404);

  const text = await obj.text();
  return new Response(text, { headers: { 'Content-Type': 'application/json' } });
}
