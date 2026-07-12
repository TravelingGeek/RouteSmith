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

  // ── Load all trip finders (owner + companions) ────────────────────────────
  const { results: tripFinderRows } = await env.DB
    .prepare(`
      SELECT tf.finder_id, tf.role,
             COALESCE(tf.display_name, f.display_name) as display_name,
             COALESCE(tf.gc_username, f.gc_username)   as gc_username
      FROM trip_finders tf
      JOIN finders f ON f.finder_id = tf.finder_id
      WHERE tf.trip_id = ?
      ORDER BY (tf.role = 'owner') DESC, tf.display_name ASC
    `)
    .bind(trip_id)
    .all<{ finder_id: string; role: string; display_name: string | null; gc_username: string | null }>();

  if (!tripFinderRows.length) throw new Error('No finders found for trip');

  const ownerFinder = tripFinderRows.find(f => f.role === 'owner');
  if (!ownerFinder) throw new Error('Trip owner finder not found');

  const finderId    = ownerFinder.finder_id;
  const gcUsername  = ownerFinder.gc_username || '';
  const displayName = ownerFinder.display_name || gcUsername;

  // Palette for pin colors — matches POC visualization
  const FINDER_COLORS = ['#2d5a2a', '#a83328', '#7a5621', '#4a6d8c', '#8a5a2a', '#6a4a7d', '#2d7a6a', '#a86a32'];
  const tripFinders = tripFinderRows.map((f, i) => ({
    finder_id: f.finder_id,
    role: f.role,
    display_name: f.display_name || f.gc_username || 'Unknown',
    gc_username: f.gc_username || '',
    color: FINDER_COLORS[i % FINDER_COLORS.length],
  }));

  console.log(`[trip_run] trip has ${tripFinders.length} finder(s): ${tripFinders.map(f=>f.display_name).join(', ')}`);

  // ── Targeted D1 queries ───────────────────────────────────────────────────

  // Q1: Trip-window finds for OWNER (full data — used for rule evaluation)
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

  console.log(`[trip_run] Q1 owner trip finds: ${tripRows.length}`);

  // ── One-time cleanup: strip "County" / "Parish" / "Borough" suffix from ──
  // county names stored before the parser normalization was added, and
  // normalize empty strings to NULL so the geocoding pass picks them up.
  // Idempotent.
  await env.DB.batch([
    env.DB.prepare(`UPDATE finder_finds SET county = NULL WHERE TRIM(COALESCE(county,'')) = ''`),
    env.DB.prepare(`UPDATE finder_finds SET state  = NULL WHERE TRIM(COALESCE(state,''))  = ''`),
    env.DB.prepare(`UPDATE caches SET county = NULL WHERE TRIM(COALESCE(county,'')) = ''`),
    env.DB.prepare(`UPDATE caches SET state  = NULL WHERE TRIM(COALESCE(state,''))  = ''`),
    // Clear misgeocoded county/state for non-US/CA finds (previous builds
    // stored Mapbox district values that don't match county grid).
    env.DB.prepare(`
      UPDATE finder_finds SET county = NULL, state = NULL
      WHERE country IS NOT NULL
        AND country NOT IN ('United States','USA','US','Canada')
    `),
    env.DB.prepare(`UPDATE finder_finds SET county = REPLACE(county, ' County', '') WHERE county LIKE '% County'`),
    env.DB.prepare(`UPDATE finder_finds SET county = REPLACE(county, ' Parish', '') WHERE county LIKE '% Parish'`),
    env.DB.prepare(`UPDATE finder_finds SET county = REPLACE(county, ' Borough', '') WHERE county LIKE '% Borough'`),
    env.DB.prepare(`UPDATE finder_finds SET county = REPLACE(county, ' Census Area', '') WHERE county LIKE '% Census Area'`),
    env.DB.prepare(`UPDATE finder_finds SET county = REPLACE(county, ' Municipality', '') WHERE county LIKE '% Municipality'`),
    env.DB.prepare(`UPDATE caches SET county = REPLACE(county, ' County', '') WHERE county LIKE '% County'`),
    env.DB.prepare(`UPDATE caches SET county = REPLACE(county, ' Parish', '') WHERE county LIKE '% Parish'`),
    env.DB.prepare(`UPDATE caches SET county = REPLACE(county, ' Borough', '') WHERE county LIKE '% Borough'`),
    env.DB.prepare(`UPDATE caches SET county = REPLACE(county, ' Census Area', '') WHERE county LIKE '% Census Area'`),
    env.DB.prepare(`UPDATE caches SET county = REPLACE(county, ' Municipality', '') WHERE county LIKE '% Municipality'`),
  ]);

  // Reload tripRows since county names may have been cleaned
  const cleanupRefresh = await env.DB
    .prepare(`
      SELECT gc_code, cache_name, cache_owner, find_date,
             county, state, country, cache_type,
             difficulty, terrain, fav_points, lat, lon, placement_date
      FROM finder_finds
      WHERE finder_id = ? AND find_date >= ? AND find_date <= ?
      ORDER BY find_date ASC
    `)
    .bind(finderId, tripStart, tripEnd)
    .all<typeof tripRows[0]>();
  tripRows.length = 0;
  tripRows.push(...cleanupRefresh.results);

  // Backfill county/state from the normalized caches table first — any cache
  // already known (e.g. via another finder's PGC upload) costs zero API calls.
  const backfill = await env.DB.prepare(`
    UPDATE finder_finds
    SET county = (SELECT c.county FROM caches c WHERE c.gc_code = finder_finds.gc_code),
        state  = (SELECT c.state  FROM caches c WHERE c.gc_code = finder_finds.gc_code)
    WHERE (county IS NULL OR state IS NULL)
      AND EXISTS (
        SELECT 1 FROM caches c
        WHERE c.gc_code = finder_finds.gc_code
          AND c.county IS NOT NULL AND c.state IS NOT NULL
      )
  `).run();
  const backfilled = (backfill as any)?.meta?.changes ?? 0;
  if (backfilled > 0) console.log(`[trip_run] backfilled county for ${backfilled} finds from caches table (0 API calls)`);

  // ── Geocoding pass: fill in county/state for any caches missing them ──────
  // Only geocodes trip-window finds — full-lifetime geocoding is deferred until
  // that finder appears on another trip. Skips finds in countries without
  // county-style subdivisions (only US and Canada are supported for map
  // attribution). NULL country is treated as unknown → still geocoded, since
  // most PQ files without country info are US anyway.
  const { results: needGeocode } = await env.DB
    .prepare(`
      SELECT DISTINCT ff.gc_code, ff.lat, ff.lon
      FROM finder_finds ff
      JOIN trip_finders tf ON tf.finder_id = ff.finder_id
      WHERE tf.trip_id = ?
        AND ff.find_date BETWEEN ? AND ?
        AND ff.lat IS NOT NULL AND ff.lon IS NOT NULL
        AND (ff.county IS NULL OR ff.county = '' OR ff.state IS NULL OR ff.state = '')
        AND (ff.country IS NULL OR ff.country IN ('United States','USA','US','Canada'))
      LIMIT 250
    `)
    .bind(trip_id, tripStart, tripEnd)
    .all<{ gc_code: string; lat: number; lon: number }>();

  if (needGeocode.length > 0 && env.MAPBOX_TOKEN) {
    console.log(`[trip_run] geocoding ${needGeocode.length} caches via Mapbox`);
    try {
      const { geocodePoint } = await import('./geocode.js');
      let hits = 0;
      const geoStart = Date.now();
      let apiMs = 0;   // cumulative time in Mapbox batches
      let dbMs  = 0;   // cumulative time writing results to D1
      // Concurrency-limited parallel calls (10 at a time) to avoid rate limits
      const CONCURRENCY = 10;
      for (let i = 0; i < needGeocode.length; i += CONCURRENCY) {
        const batch = needGeocode.slice(i, i + CONCURRENCY);
        const t0 = Date.now();
        const results = await Promise.all(
          batch.map(async c => {
            const loc = await geocodePoint(c.lat, c.lon, env.MAPBOX_TOKEN);
            return { gc_code: c.gc_code, loc };
          })
        );
        apiMs += Date.now() - t0;
        const stmts = [];
        for (const r of results) {
          if (!r.loc) continue;
          hits++;
          stmts.push(env.DB.prepare(
            `UPDATE finder_finds SET county = ?, state = ? WHERE gc_code = ? AND (county IS NULL OR state IS NULL)`
          ).bind(r.loc.county, r.loc.state, r.gc_code));
          stmts.push(env.DB.prepare(`
            UPDATE caches SET county = ?, state = ?, county_source = 'geocoded', updated_at = ?
            WHERE gc_code = ? AND (county_source IS NULL OR county_source = 'geocoded')
          `).bind(r.loc.county, r.loc.state, ts, r.gc_code));
        }
        if (stmts.length > 0) {
          const t1 = Date.now();
          await env.DB.batch(stmts);
          dbMs += Date.now() - t1;
        }
      }
      const totalMs = Date.now() - geoStart;
      console.log(
        `[trip_run] geocoded ${hits}/${needGeocode.length} caches in ${totalMs}ms ` +
        `(mapbox: ${apiMs}ms, d1 writes: ${dbMs}ms, ` +
        `${(totalMs / needGeocode.length).toFixed(1)}ms/cache avg, concurrency=${CONCURRENCY})`
      );
    } catch (e) {
      console.error(`Geocoding failed: ${(e as Error).message}`);
    }

    // Re-query tripRows so downstream sees the newly geocoded values
    const refresh = await env.DB
      .prepare(`
        SELECT gc_code, cache_name, cache_owner, find_date,
               county, state, country, cache_type,
               difficulty, terrain, fav_points, lat, lon, placement_date
        FROM finder_finds
        WHERE finder_id = ? AND find_date >= ? AND find_date <= ?
        ORDER BY find_date ASC
      `)
      .bind(finderId, tripStart, tripEnd)
      .all<typeof tripRows[0]>();
    tripRows.length = 0;
    tripRows.push(...refresh.results);
  } else if (needGeocode.length > 0) {
    console.warn(`[trip_run] ${needGeocode.length} caches need geocoding but MAPBOX_TOKEN is not set`);
  }

  // Q1b: Per-companion trip finds (for county attribution + per-finder stats)
  const perFinderTripFinds: Record<string, Array<{ gc_code: string; county: string | null; state: string | null; country: string | null; find_date: string }>> = {};
  perFinderTripFinds[finderId] = tripRows.map(r => ({
    gc_code: r.gc_code, county: r.county, state: r.state, country: r.country, find_date: r.find_date
  }));

  // Q1c: Per-finder PRIOR counties (for determining new vs previously found per finder)
  const perFinderPriorCounties: Record<string, Set<string>> = {};

  // Owner's prior counties (also used later as priorCounties)
  const { results: ownerPriorCountyRows } = await env.DB
    .prepare(`
      SELECT DISTINCT county, state FROM finder_finds
      WHERE finder_id = ? AND find_date < ? AND county IS NOT NULL AND state IS NOT NULL
    `)
    .bind(finderId, tripStart)
    .all<{ county: string; state: string }>();
  perFinderPriorCounties[finderId] = new Set(ownerPriorCountyRows.map(r => `${r.county}|${r.state}`));

  const companions = tripFinders.filter(f => f.role !== 'owner');
  for (const c of companions) {
    const { results: cRows } = await env.DB
      .prepare(`
        SELECT gc_code, county, state, country, find_date
        FROM finder_finds
        WHERE finder_id = ? AND find_date >= ? AND find_date <= ?
      `)
      .bind(c.finder_id, tripStart, tripEnd)
      .all<{ gc_code: string; county: string | null; state: string | null; country: string | null; find_date: string }>();
    perFinderTripFinds[c.finder_id] = cRows;

    // Per-companion prior counties (for status determination)
    const { results: cPriorCounties } = await env.DB
      .prepare(`
        SELECT DISTINCT county, state FROM finder_finds
        WHERE finder_id = ? AND find_date < ? AND county IS NOT NULL AND state IS NOT NULL
      `)
      .bind(c.finder_id, tripStart)
      .all<{ county: string; state: string }>();
    perFinderPriorCounties[c.finder_id] = new Set(cPriorCounties.map(r => `${r.county}|${r.state}`));

    console.log(`[trip_run] Q1b companion ${c.display_name}: ${cRows.length} finds, ${cPriorCounties.length} prior counties`);
  }

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
    computeStateCompletions,
  } = await import('./statistics.js');
  const { buildDefaultRules, evaluateAllRules } = await import('./rules.js');
  const { fetchReferenceListsFromR2, injectReferenceContext } = await import('./referenceLists.js');
  const { buildCountiesData, buildPerFinderCountyAttribution } = await import('./countyMap.js');

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

  // Legacy lifetimeMinimal — kept for milestone computation (needs waypoint list)
  const lifetimeMinimal: WaypointLike[] = jasmerCountRows.map(r => ({
    gcCode: 'prior', name: 'prior', cacheType: null,
    lat: 0, lon: 0, container: null, difficulty: null, terrain: null,
    country: null, state: null, county: null,
    placementTime: new Date(r.placement_month + '-01T00:00:00Z'),
    findDate: new Date('2000-01-01T00:00:00Z'),
    favoritePoints: 0, cacheOwner: null,
    attributes: new Set(), finderLogText: null, sym: null, archived: false,
  }));

  const tripStartDate = new Date(tripStart + 'T00:00:00Z');
  const tripEndDate   = new Date(tripEnd   + 'T00:00:00Z');

  // ── Statistics ────────────────────────────────────────────────────────────
  console.log('[trip_run] computing statistics');

  const aggregate    = computeAggregateStats(tripFinds as any, priorCounties, priorStates, priorCountries, priorTypes);
  const byDay        = computeDailyStats(tripFinds as any, priorCounties, tripStartDate, tripEndDate);
  const milestones   = computeMilestones([...lifetimeMinimal, ...tripFinds] as any, tripStartDate, tripEndDate);
  const stateComps   = computeStateCompletions(tripFinds as any, priorCounties);
  const countiesData = buildCountiesData(tripFinds as any, priorCounties);

  // Per-finder county attribution — for county map pins showing who found what
  const perFinderAttribution = buildPerFinderCountyAttribution(perFinderTripFinds, perFinderPriorCounties);

  // ── Per-finder + combined progress data ─────────────────────────────────
  // For every finder + a combined "any finder" view, capture:
  //   - lifetime states/countries found (as of trip end)
  //   - trip states/countries newly added this trip
  //   - lifetime county count per state
  //   - trip county deltas per state
  // Frontend uses this to render the Counties/Progress table.
  const progressData: {
    perFinder: Record<string, { states: string[]; countries: string[]; countyCountByState: Record<string, number>; tripNewStates: string[]; tripNewCountries: string[]; tripCountyByState: Record<string, number>; tripFindsByState: Record<string, number>; tripFindsByCountry: Record<string, number> }>;
    combined:  { states: string[]; countries: string[]; countyCountByState: Record<string, number>; tripNewStates: string[]; tripNewCountries: string[]; tripCountyByState: Record<string, number>; countryToStates: Record<string, string[]>; tripFindsByState: Record<string, number>; tripFindsByCountry: Record<string, number> };
  } = {
    perFinder: {},
    combined: { states: [], countries: [], countyCountByState: {}, tripNewStates: [], tripNewCountries: [], tripCountyByState: {}, countryToStates: {}, tripFindsByState: {}, tripFindsByCountry: {} },
  };

  // Per-finder loop: query lifetime data + slice trip contribution from the trip-finds we already have
  for (const f of tripFinders) {
    const priorStateRowsF = await env.DB
      .prepare(`SELECT DISTINCT state FROM finder_finds WHERE finder_id = ? AND find_date < ? AND state IS NOT NULL AND state != ''`)
      .bind(f.finder_id, tripStart)
      .all<{ state: string }>();
    const priorCountryRowsF = await env.DB
      .prepare(`SELECT DISTINCT country FROM finder_finds WHERE finder_id = ? AND find_date < ? AND country IS NOT NULL AND country != ''`)
      .bind(f.finder_id, tripStart)
      .all<{ country: string }>();
    const priorCountyByStateRowsF = await env.DB
      .prepare(`SELECT state, COUNT(DISTINCT county) AS n FROM finder_finds WHERE finder_id = ? AND find_date < ? AND state IS NOT NULL AND state != '' AND county IS NOT NULL AND county != '' GROUP BY state`)
      .bind(f.finder_id, tripStart)
      .all<{ state: string; n: number }>();

    const priorStatesF    = new Set(priorStateRowsF.results.map(r => r.state));
    const priorCountriesF = new Set(priorCountryRowsF.results.map(r => r.country));

    const tripFindsF = perFinderTripFinds[f.finder_id] ?? [];
    const tripStates    = new Set<string>();
    const tripCountries = new Set<string>();
    const tripCountyByState: Record<string, Set<string>> = {};
    const tripFindsByState:   Record<string, number> = {};
    const tripFindsByCountry: Record<string, number> = {};
    for (const fd of tripFindsF) {
      if (fd.state) {
        tripStates.add(fd.state);
        tripFindsByState[fd.state] = (tripFindsByState[fd.state] ?? 0) + 1;
      }
      if ((fd as any).country) {
        tripCountries.add((fd as any).country);
        tripFindsByCountry[(fd as any).country] = (tripFindsByCountry[(fd as any).country] ?? 0) + 1;
      }
      if (fd.county && fd.state) {
        (tripCountyByState[fd.state] ||= new Set()).add(fd.county);
      }
    }

    const allStates     = new Set([...priorStatesF, ...tripStates]);
    const allCountries  = new Set([...priorCountriesF, ...tripCountries]);
    const tripNewStates    = [...tripStates].filter(s => !priorStatesF.has(s));
    const tripNewCountries = [...tripCountries].filter(c => !priorCountriesF.has(c));

    // Lifetime county count per state (post-trip = prior + trip-adds not previously counted)
    // Simpler: query lifetime county count per state fresh
    const lifetimeCountyRowsF = await env.DB
      .prepare(`SELECT state, COUNT(DISTINCT county) AS n FROM finder_finds WHERE finder_id = ? AND state IS NOT NULL AND state != '' AND county IS NOT NULL AND county != '' AND find_date <= ? GROUP BY state`)
      .bind(f.finder_id, tripEnd)
      .all<{ state: string; n: number }>();

    const countyCountByState: Record<string, number> = {};
    for (const r of lifetimeCountyRowsF.results) countyCountByState[r.state] = r.n;

    const tripCountyByStateCount: Record<string, number> = {};
    for (const [st, set] of Object.entries(tripCountyByState)) {
      const prior = priorCountyByStateRowsF.results.find(r => r.state === st)?.n ?? 0;
      const lifetime = countyCountByState[st] ?? 0;
      tripCountyByStateCount[st] = lifetime - prior;  // net new counties this trip
    }

    progressData.perFinder[f.finder_id] = {
      states: [...allStates].sort(),
      countries: [...allCountries].sort(),
      countyCountByState,
      tripNewStates,
      tripNewCountries,
      tripCountyByState: tripCountyByStateCount,
      tripFindsByState,
      tripFindsByCountry,
    };
  }

  // Combined — union across finders
  const combinedStates = new Set<string>();
  const combinedCountries = new Set<string>();
  const combinedTripNewStates = new Set<string>();
  const combinedTripNewCountries = new Set<string>();
  const combinedCountyByState: Record<string, Set<string>> = {};
  const combinedPriorCountyByState: Record<string, Set<string>> = {};
  const countryToStates: Record<string, Set<string>> = {};

  for (const f of tripFinders) {
    const p = progressData.perFinder[f.finder_id];
    for (const s of p.states) combinedStates.add(s);
    for (const c of p.countries) combinedCountries.add(c);
    for (const s of p.tripNewStates) combinedTripNewStates.add(s);
    for (const c of p.tripNewCountries) combinedTripNewCountries.add(c);
  }

  // Lifetime + prior county sets per state, combined across finders
  const combinedLifetimeRows = await env.DB
    .prepare(`
      SELECT DISTINCT ff.state, ff.county, ff.country FROM finder_finds ff
      JOIN trip_finders tf ON tf.finder_id = ff.finder_id
      WHERE tf.trip_id = ?
        AND ff.state IS NOT NULL AND ff.state != ''
        AND ff.county IS NOT NULL AND ff.county != ''
        AND ff.find_date <= ?
    `)
    .bind(trip_id, tripEnd)
    .all<{ state: string; county: string; country: string | null }>();

  // Combined trip find counts by state / country — deduped by gc_code across finders
  const combinedTripFindRows = await env.DB
    .prepare(`
      SELECT DISTINCT ff.gc_code, ff.state, ff.country FROM finder_finds ff
      JOIN trip_finders tf ON tf.finder_id = ff.finder_id
      WHERE tf.trip_id = ?
        AND ff.find_date BETWEEN ? AND ?
    `)
    .bind(trip_id, tripStart, tripEnd)
    .all<{ gc_code: string; state: string | null; country: string | null }>();
  const combinedTripFindsByState:   Record<string, number> = {};
  const combinedTripFindsByCountry: Record<string, number> = {};
  for (const r of combinedTripFindRows.results) {
    if (r.state)   combinedTripFindsByState[r.state]     = (combinedTripFindsByState[r.state]     ?? 0) + 1;
    if (r.country) combinedTripFindsByCountry[r.country] = (combinedTripFindsByCountry[r.country] ?? 0) + 1;
  }
  for (const r of combinedLifetimeRows.results) {
    (combinedCountyByState[r.state] ||= new Set()).add(r.county);
    if (r.country) (countryToStates[r.country] ||= new Set()).add(r.state);
  }

  const combinedPriorRows = await env.DB
    .prepare(`
      SELECT DISTINCT ff.state, ff.county FROM finder_finds ff
      JOIN trip_finders tf ON tf.finder_id = ff.finder_id
      WHERE tf.trip_id = ?
        AND ff.state IS NOT NULL AND ff.state != ''
        AND ff.county IS NOT NULL AND ff.county != ''
        AND ff.find_date < ?
    `)
    .bind(trip_id, tripStart)
    .all<{ state: string; county: string }>();
  for (const r of combinedPriorRows.results) {
    (combinedPriorCountyByState[r.state] ||= new Set()).add(r.county);
  }

  const combinedCountyCountByState: Record<string, number> = {};
  const combinedTripCountyByState: Record<string, number> = {};
  for (const [st, set] of Object.entries(combinedCountyByState)) {
    combinedCountyCountByState[st] = set.size;
    const prior = combinedPriorCountyByState[st]?.size ?? 0;
    combinedTripCountyByState[st] = set.size - prior;
  }

  progressData.combined = {
    states: [...combinedStates].sort(),
    countries: [...combinedCountries].sort(),
    countyCountByState: combinedCountyCountByState,
    tripNewStates: [...combinedTripNewStates],
    tripNewCountries: [...combinedTripNewCountries],
    tripCountyByState: combinedTripCountyByState,
    countryToStates: Object.fromEntries(Object.entries(countryToStates).map(([k, v]) => [k, [...v].sort()])),
    tripFindsByState: combinedTripFindsByState,
    tripFindsByCountry: combinedTripFindsByCountry,
  };

  // Per-finder stats — total finds and counties for each finder on this trip
  const perFinderStats = tripFinders.map(f => {
    const finds = perFinderTripFinds[f.finder_id] ?? [];
    const counties = new Set<string>();
    for (const fd of finds) {
      if (fd.county && fd.state) counties.add(`${fd.county}|${fd.state}`);
    }
    return {
      finder_id: f.finder_id,
      display_name: f.display_name,
      gc_username: f.gc_username,
      role: f.role,
      color: f.color,
      find_count: finds.length,
      county_count: counties.size,
    };
  });

  // ── Loop state for Jasmer + DT ────────────────────────────────────────────
  const { computeJasmerLoopState, computeDtLoopState } = await import('./statistics.js');
  const jasmerLoopState = computeJasmerLoopState(
    jasmerCountRows.map(r => ({ month: r.placement_month, priorCount: r.prior_count })),
    jasmerTripRows.map(r  => ({ gcCode: r.gc_code, month: r.placement_month, findDate: r.find_date }))
  );
  const dtLoopState = computeDtLoopState(
    dtCountRows.map(r => ({ difficulty: r.difficulty, terrain: r.terrain, priorCount: r.prior_count })),
    dtTripRows.map(r  => ({ gcCode: r.gc_code, difficulty: r.difficulty, terrain: r.terrain, findDate: r.find_date }))
  );

  // Fills maps used by rule evaluation (backwards-compatible shape)
  const jasmerFills = new Map<string, string>();
  const MONTHS = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (const [gc, cell] of jasmerLoopState.newFillsThisTrip) {
    const [y, m] = cell.split('-');
    jasmerFills.set(gc, `${MONTHS[parseInt(m)]} ${y}`);
  }
  const dtFills = new Map<string, [number, number]>();
  for (const [gc, cell] of dtLoopState.newFillsThisTrip) {
    const [d, t] = cell.split('|').map(Number);
    dtFills.set(gc, [d, t]);
  }

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
    finders: perFinderStats,
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
      previouslyFound: [...(countiesData as any).previouslyFound].slice(0, 500),
      countyAttribution: perFinderAttribution.countyAttribution,
    },
    progressData,
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
