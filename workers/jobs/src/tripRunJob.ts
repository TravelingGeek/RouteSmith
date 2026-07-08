/**
 * tripRunJob.ts — Trip pipeline job handler for the routesmith-jobs Worker.
 *
 * Runs the full trip-window pipeline using targeted D1 queries.
 * No GPX parsing — all data comes from finder_finds in D1.
 * Stores result JSON in R2 and marks job complete.
 */

import type { Env, TripRunPayload, TripRunResult } from './types.js';
import { countyKey, STATE_ABBREVIATIONS } from './types.js';

export async function handleTripRunJob(
  jobId: string,
  userId: string,
  payload: TripRunPayload,
  attemptNumber: number,
  env: Env,
): Promise<TripRunResult> {
  const ts = Math.floor(Date.now() / 1000);

  // Check if job was cancelled before processing
  const jobCheck = await env.DB
    .prepare(`SELECT status FROM jobs WHERE job_id = ?`)
    .bind(jobId)
    .first<{ status: string }>();
  if (jobCheck?.status === 'cancelled') {
    console.log(`[trip_run] job_id=${jobId} cancelled before processing`);
    return { result_r2_key: '', trip_find_count: 0, lifetime_find_count: 0 };
  }

  await env.DB.prepare(
    `UPDATE jobs SET status = 'processing', attempt_count = ?, updated_at = ? WHERE job_id = ?`
  ).bind(attemptNumber, ts, jobId).run();

  console.log(`[trip_run] job_id=${jobId} trip_id=${payload.trip_id} attempt=${attemptNumber}`);

  const { trip_id, result_r2_key } = payload;

  // ── Load trip ─────────────────────────────────────────────────────────────
  const trip = await env.DB
    .prepare(`SELECT * FROM trips WHERE trip_id = ? AND user_id = ?`)
    .bind(trip_id, userId)
    .first<{
      trip_id: string; name: string; status: string;
      date_start: string; date_end: string;
      user_notes: string | null; distance_miles: number | null;
    }>();

  if (!trip) throw new Error(`Trip not found: ${trip_id}`);

  const tripStart = trip.date_start;
  const tripEnd   = trip.date_end;

  // ── Load owner finder ─────────────────────────────────────────────────────
  const ownerFinder = await env.DB
    .prepare(`
      SELECT tf.finder_id, tf.gc_username, tf.display_name,
             f.gc_username as f_gc_username, f.display_name as f_display_name
      FROM trip_finders tf
      JOIN finders f ON f.finder_id = tf.finder_id
      WHERE tf.trip_id = ? AND tf.role = 'owner'
    `)
    .bind(trip_id)
    .first<{
      finder_id: string; gc_username: string | null; display_name: string | null;
      f_gc_username: string | null; f_display_name: string | null;
    }>();

  if (!ownerFinder) throw new Error('Trip owner finder not found');

  const finderId    = ownerFinder.finder_id;
  const gcUsername  = ownerFinder.gc_username || ownerFinder.f_gc_username || '';
  const displayName = ownerFinder.display_name || ownerFinder.f_display_name || gcUsername;

  // ── Targeted D1 queries ───────────────────────────────────────────────────

  // Q1: Trip-window finds (full data)
  const { results: tripRows } = await env.DB
    .prepare(`
      SELECT gc_code, cache_name, cache_owner, find_date,
             county, state, country, cache_type,
             difficulty, terrain, fav_points, lat, lon, placement_date
      FROM finder_finds
      WHERE finder_id = ? AND find_date >= ? AND find_date <= ?
      ORDER BY find_date ASC
    `)
    .bind(finderId, tripStart, tripEnd)
    .all<{
      gc_code: string; cache_name: string | null; cache_owner: string | null;
      find_date: string; county: string | null; state: string | null;
      country: string | null; cache_type: string | null;
      difficulty: number | null; terrain: number | null;
      fav_points: number; lat: number | null; lon: number | null;
      placement_date: string | null;
    }>();

  console.log(`[trip_run] Q1 trip finds: ${tripRows.length}`);

  // Q2-5: Prior data (DISTINCT queries)
  const [priorCountyRows, priorStateRows, priorCountryRows, priorTypeRows] = await Promise.all([
    env.DB.prepare(`SELECT DISTINCT county, state FROM finder_finds WHERE finder_id = ? AND find_date < ? AND county IS NOT NULL AND state IS NOT NULL`).bind(finderId, tripStart).all<{ county: string; state: string }>(),
    env.DB.prepare(`SELECT DISTINCT state FROM finder_finds WHERE finder_id = ? AND find_date < ? AND state IS NOT NULL`).bind(finderId, tripStart).all<{ state: string }>(),
    env.DB.prepare(`SELECT DISTINCT country FROM finder_finds WHERE finder_id = ? AND find_date < ? AND country IS NOT NULL`).bind(finderId, tripStart).all<{ country: string }>(),
    env.DB.prepare(`SELECT DISTINCT cache_type FROM finder_finds WHERE finder_id = ? AND find_date < ? AND cache_type IS NOT NULL`).bind(finderId, tripStart).all<{ cache_type: string }>(),
  ]);

  console.log(`[trip_run] Q2-5 prior data: ${priorCountyRows.results.length} counties, ${priorStateRows.results.length} states`);

  const priorCounties  = new Set(priorCountyRows.results.map(r => countyKey(r.county, r.state)));
  const priorStates    = new Set(priorStateRows.results.map(r => r.state));
  const priorCountries = new Set(priorCountryRows.results.map(r => r.country));
  const priorTypes     = new Set(priorTypeRows.results.map(r => r.cache_type));

  // Q6a: Prior find count
  const priorCountResult = await env.DB
    .prepare(`SELECT COUNT(*) as cnt FROM finder_finds WHERE finder_id = ? AND find_date < ?`)
    .bind(finderId, tripStart)
    .first<{ cnt: number }>();
  const priorFindCount = priorCountResult?.cnt ?? 0;

  // Q6b: Jasmer — count finds per placement month (for loop detection)
  const { results: jasmerCountRows } = await env.DB
    .prepare(`
      SELECT SUBSTR(placement_date, 1, 7) as placement_month,
             COUNT(*) as prior_count
      FROM finder_finds
      WHERE finder_id = ? AND placement_date IS NOT NULL AND find_date < ?
      GROUP BY SUBSTR(placement_date, 1, 7)
    `)
    .bind(finderId, tripStart)
    .all<{ placement_month: string; prior_count: number }>();

  // Trip Jasmer fills — placement months hit by trip finds
  const { results: jasmerTripRows } = await env.DB
    .prepare(`
      SELECT gc_code, find_date, SUBSTR(placement_date, 1, 7) as placement_month
      FROM finder_finds
      WHERE finder_id = ? AND placement_date IS NOT NULL AND find_date BETWEEN ? AND ?
      ORDER BY find_date ASC
    `)
    .bind(finderId, tripStart, tripEnd)
    .all<{ gc_code: string; find_date: string; placement_month: string }>();

  // Q6c: DT — count finds per (D,T) cell for loop detection
  const { results: dtCountRows } = await env.DB
    .prepare(`
      SELECT difficulty, terrain, COUNT(*) as prior_count
      FROM finder_finds
      WHERE finder_id = ? AND difficulty IS NOT NULL AND terrain IS NOT NULL AND find_date < ?
      GROUP BY difficulty, terrain
    `)
    .bind(finderId, tripStart)
    .all<{ difficulty: number; terrain: number; prior_count: number }>();

  // Trip DT fills — (D,T) hit by trip finds
  const { results: dtTripRows } = await env.DB
    .prepare(`
      SELECT gc_code, find_date, difficulty, terrain
      FROM finder_finds
      WHERE finder_id = ? AND difficulty IS NOT NULL AND terrain IS NOT NULL AND find_date BETWEEN ? AND ?
      ORDER BY find_date ASC
    `)
    .bind(finderId, tripStart, tripEnd)
    .all<{ gc_code: string; find_date: string; difficulty: number; terrain: number }>();

  console.log(`[trip_run] jasmer months (prior): ${jasmerCountRows.length}, trip: ${jasmerTripRows.length}, DT cells (prior): ${dtCountRows.length}, trip: ${dtTripRows.length}`);

  // ── Import pipeline modules ───────────────────────────────────────────────
  const {
    computeAggregateStats, computeDailyStats, computeMilestones,
    computeJasmerFills, computeJasmerGridState, computeDtFills,
    computeStateCompletions,
  } = await import('./statistics.js');
  const { buildDefaultRules, evaluateAllRules } = await import('./rules.js');
  const { fetchReferenceListsFromR2, injectReferenceContext } = await import('./referenceLists.js');
  const { buildCountiesData } = await import('./countyMap.js');

  // ── Convert rows to Waypoint-like objects ─────────────────────────────────
  type WaypointLike = {
    gcCode: string; name: string; cacheType: string | null;
    lat: number; lon: number; container: null;
    difficulty: number | null; terrain: number | null;
    country: string | null; state: string | null; county: string | null;
    placementTime: Date | null; findDate: Date;
    favoritePoints: number; cacheOwner: string | null;
    attributes: Set<number>; finderLogText: null; sym: null; archived: boolean;
  };

  const tripFinds: WaypointLike[] = tripRows.map(r => ({
    gcCode: r.gc_code, name: r.cache_name ?? r.gc_code, cacheType: r.cache_type,
    lat: r.lat ?? 0, lon: r.lon ?? 0, container: null,
    difficulty: r.difficulty, terrain: r.terrain,
    country: r.country, state: r.state, county: r.county,
    placementTime: r.placement_date ? new Date(r.placement_date + 'T00:00:00Z') : null,
    findDate: new Date(r.find_date + 'T12:00:00Z'),
    favoritePoints: r.fav_points ?? 0, cacheOwner: r.cache_owner,
    attributes: new Set(), finderLogText: null, sym: null, archived: false,
  }));

  // Legacy lifetimeMinimal — kept for other functions that still expect it
  const lifetimeMinimal: WaypointLike[] = jasmerCountRows.map(r => ({
    gcCode: r.gc_code, name: r.gc_code, cacheType: null,
    lat: 0, lon: 0, container: null, difficulty: null, terrain: null,
    country: null, state: null, county: null,
    placementTime: new Date(r.placement_month + '-01T00:00:00Z'),
    findDate: new Date(r.find_date + 'T12:00:00Z'),
    favoritePoints: 0, cacheOwner: null,
    attributes: new Set(), finderLogText: null, sym: null, archived: false,
  }));

  const priorDtWaypoints: WaypointLike[] = dtRows.map(r => ({
    gcCode: 'prior', name: 'prior', cacheType: null,
    lat: 0, lon: 0, container: null,
    difficulty: r.difficulty, terrain: r.terrain,
    country: null, state: null, county: null,
    placementTime: null, findDate: new Date('2000-01-01T00:00:00Z'),
    favoritePoints: 0, cacheOwner: null,
    attributes: new Set(), finderLogText: null, sym: null, archived: false,
  }));

  const tripStartDate = new Date(tripStart + 'T00:00:00Z');
  const tripEndDate   = new Date(tripEnd   + 'T00:00:00Z');

  // ── Statistics ────────────────────────────────────────────────────────────
  console.log('[trip_run] computing statistics');

  const aggregate   = computeAggregateStats(tripFinds as any, priorCounties, priorStates, priorCountries, priorTypes);
  const byDay       = computeDailyStats(tripFinds as any, priorCounties, tripStartDate, tripEndDate);
  const milestones  = computeMilestones([...lifetimeMinimal, ...tripFinds] as any, tripStartDate, tripEndDate);
  const jasmerFills = computeJasmerFills(lifetimeMinimal as any, tripStartDate, tripEndDate);
  const dtFills     = computeDtFills([...priorDtWaypoints, ...tripFinds] as any, tripStartDate, tripEndDate);
  const stateComps  = computeStateCompletions(tripFinds as any, priorCounties);
  const jasmerGrid  = computeJasmerGridState(lifetimeMinimal as any, tripStartDate, tripEndDate);
  const countiesData = buildCountiesData(tripFinds as any, priorCounties);

  // ── Rules ─────────────────────────────────────────────────────────────────
  console.log('[trip_run] evaluating rules');

  const ctx: Record<string, unknown> = { priorCounties, priorStates, priorCountries, priorTypes };
  for (const [gc, m] of milestones)  ctx[`milestone_for_${gc}`] = m;
  for (const [gc, c] of jasmerFills) ctx[`jasmer_fill_${gc}`] = c;
  for (const [gc, c] of dtFills)     ctx[`dt_fill_${gc}`] = c;
  for (const [gc, i] of stateComps)  ctx[`state_completion_${gc}`] = i;
  for (const [s, a] of Object.entries(STATE_ABBREVIATIONS)) ctx[`stateAbbrev_${s}`] = a;

  const refLists = await fetchReferenceListsFromR2(env.REPORT_BUCKET as any);
  injectReferenceContext(ctx, refLists);

  const rules = buildDefaultRules();
  const { results: ruleResults, warnings } = evaluateAllRules(tripFinds as any, rules, ctx as any);

  console.log(`[trip_run] rules fired: ${ruleResults.length}`);

  // ── Serialize and store result ────────────────────────────────────────────
  // Pre-map byDay to avoid circular reference issues and reduce result size
  const mappedByDay = byDay.map((ds: any) => ({
    dayDate: ds.dayDate.toISOString().slice(0, 10),
    findCount: ds.finds,
    favoritePoints: ds.favoritePoints,
    newCounties: ds.newCounties,
    byCacheType: ds.byCacheType,
    bestFind: ds.bestFind ? {
      gc_code: ds.bestFind.gcCode,
      cache_name: ds.bestFind.name,
      fav_points: ds.bestFind.favoritePoints,
      cache_type: ds.bestFind.cacheType,
    } : null,
  }));

  const result = {
    trip_id,
    trip_name: trip.name,
    start_date: tripStart,
    end_date: tripEnd,
    generated_at: ts,
    lifetime_find_count: priorFindCount + tripFinds.length,
    trip_find_count: tripFinds.length,
    warnings: [...refLists.warnings, ...warnings],
    diagnostics: tripFinds.length === 0
      ? [`No finds found between ${tripStart} and ${tripEnd} for ${gcUsername}.`]
      : [],
    owner: { finder_id: finderId, display_name: displayName, gc_username: gcUsername },
    aggregate,
    byDay: mappedByDay,
    ruleResults: ruleResults.map((rr: any) => ({
      id:          rr.rule.id,
      displayName: rr.rule.displayName,
      severity:    rr.rule.severity,
      description: rr.rule.description ?? null,
      matches: rr.matches.map((m: any) => ({
        gc_code:    m.waypoint.gcCode,
        cache_name: m.waypoint.name,
        note:       m.note,
        fav_points: m.waypoint.favoritePoints,
        cache_type: m.waypoint.cacheType,
        difficulty: m.waypoint.difficulty,
        terrain:    m.waypoint.terrain,
        lat:        m.waypoint.lat,
        lon:        m.waypoint.lon,
        find_date:  m.waypoint.findDate?.toISOString().slice(0, 10) ?? null,
      })),
    })),
    allRules: rules.map((r: any) => ({
      id:          r.id,
      displayName: r.displayName,
      severity:    r.severity,
      description: r.description ?? null,
    })),
    countiesData: {
      firstTimeCount: (countiesData as any).firstTime.size,
      previouslyFoundCount: (countiesData as any).previouslyFound.size,
      firstTime: [...(countiesData as any).firstTime].slice(0, 500),
    },
    jasmer: {
      loopNumber: jasmerLoopState.loopNumber,
      totalCellsInLoop: jasmerLoopState.totalCells,
      completedCellsInLoop: jasmerLoopState.completedCells,
      cellCounts: jasmerLoopState.cellCounts,      // {month: count}
      newFillsThisTrip: [...jasmerLoopState.newFillsThisTrip.entries()],
      tripAdditionsPerCell: jasmerLoopState.tripAdditionsPerCell,
    },
    dtGrid: {
      loopNumber: dtLoopState.loopNumber,
      totalCellsInLoop: dtLoopState.totalCells,
      completedCellsInLoop: dtLoopState.completedCells,
      cellCounts: dtLoopState.cellCounts,          // {"d|t": count}
      newFillsThisTrip: [...dtLoopState.newFillsThisTrip.entries()],
      tripAdditionsPerCell: dtLoopState.tripAdditionsPerCell,
    },
    jasmerNewCells: [...jasmerLoopState.newFillsThisTrip.entries()]
      .filter(([gc]) => tripFinds.some(w => w.gcCode === gc))
      .map(([gc, cell]) => ({ gcCode: gc, cell })),
    fieldAvailability: {
      hasCounty: tripFinds.filter(w => w.county).length / Math.max(tripFinds.length, 1) >= 0.1,
      hasFp: tripFinds.filter(w => w.favoritePoints > 0).length / Math.max(tripFinds.length, 1) >= 0.1,
    },
  };
// Diagnose which fields are large
  console.log('[trip_run] size breakdown:',
    'ruleResults:', JSON.stringify(result.ruleResults).length,
    'byDay (raw):', JSON.stringify(byDay).length,
    'byDay (mapped):', JSON.stringify(mappedByDay).length,
    'countiesData:', JSON.stringify(result.countiesData).length,
    'jasmerNewCells:', JSON.stringify(result.jasmerNewCells).length,
    'aggregate:', JSON.stringify(result.aggregate).length,
  );
  const serialized = JSON.stringify(result);
const encoded = new TextEncoder().encode(serialized);
  await env.REPORT_BUCKET.put(result_r2_key, encoded.buffer as ArrayBuffer, {
    httpMetadata: { contentType: 'application/json' },
  });

  console.log(`[trip_run] result stored at ${result_r2_key}`);

  // ── Store report reference in D1 ──────────────────────────────────────────
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO trip_reports (report_id, trip_id, generated_at, output_r2_key, field_flags)
      VALUES (?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), trip_id, ts, result_r2_key, JSON.stringify(result.fieldAvailability)),
    // Clear the stale flag — report is now fresh
    env.DB.prepare(`UPDATE trips SET report_invalidated_at = NULL WHERE trip_id = ?`).bind(trip_id),
  ]);

  const jobResult: TripRunResult = {
    result_r2_key,
    trip_find_count: tripFinds.length,
    lifetime_find_count: priorFindCount + tripFinds.length,
  };

  await env.DB.prepare(
    `UPDATE jobs SET status = 'complete', result_json = ?, updated_at = ?, completed_at = ? WHERE job_id = ?`
  ).bind(JSON.stringify(jobResult), ts, ts, jobId).run();

  return jobResult;
}
