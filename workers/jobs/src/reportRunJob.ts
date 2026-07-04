/**
 * reportRunJob.ts — Report pipeline job handler for the routesmith-jobs Worker.
 */

import type { Env, ReportRunPayload, ReportRunResult } from './types.js';
import { parseGpxTextAsync } from './gpxParser.js';
import { runPipelineFromWaypoints } from './pipeline.js';
import { fetchReferenceListsFromR2 } from './referenceLists.js';
import { unzipSync } from 'fflate';

export async function handleReportRunJob(
  jobId: string,
  userId: string,
  payload: ReportRunPayload,
  attemptNumber: number,
  env: Env,
): Promise<ReportRunResult> {
  const ts = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `UPDATE jobs SET status = 'processing', attempt_count = ?, updated_at = ? WHERE job_id = ?`
  ).bind(attemptNumber, ts, jobId).run();

  // ── Helper: fetch one GPX file and parse to Waypoints ──────────────────
  async function fetchAndParse(
    gpxFileId: string,
    gcUsername: string | null,
  ): Promise<import('./types.js').Waypoint[]> {
    const row = await env.DB
      .prepare(`
        SELECT gf.r2_key FROM gpx_files gf
        JOIN finders f ON f.finder_id = gf.owner_finder_id
        WHERE gf.gpx_file_id = ?
          AND f.owner_user_id = ?
          AND gf.is_active = 1
          AND gf.deleted_at IS NULL
      `)
      .bind(gpxFileId, userId)
      .first<{ r2_key: string }>();

    if (!row) throw new Error(`GPX file not found: ${gpxFileId}`);

    const obj = await env.REPORT_BUCKET.get(row.r2_key);
    if (!obj) throw new Error(`R2 object missing: ${row.r2_key}`);

    const buffer = await obj.arrayBuffer();
    const waypoints = new Map<string, import('./types.js').Waypoint>();

    let gpxTexts: string[];
    if (row.r2_key.toLowerCase().endsWith('.zip')) {
      const files = unzipSync(new Uint8Array(buffer));
      const gpxEntries = Object.entries(files).filter(
        ([n]) => n.toLowerCase().endsWith('.gpx') && !n.toLowerCase().includes('wpts')
      );
      if (!gpxEntries.length) throw new Error(`ZIP ${gpxFileId} contains no .gpx files`);
      const decoder = new TextDecoder('utf-8');
      gpxTexts = gpxEntries.map(([, data]) => decoder.decode(data));
    } else {
      gpxTexts = [new TextDecoder('utf-8').decode(buffer)];
    }

    for (const text of gpxTexts) {
      const wpts = await parseGpxTextAsync(text, gcUsername);
      for (const w of wpts) waypoints.set(w.gcCode, w);
    }

    return Array.from(waypoints.values());
  }

  // ── Fetch and parse all GPX files sequentially ──────────────────────────
  const ownerWaypoints = new Map<string, import('./types.js').Waypoint>();
  for (const gpxFileId of payload.owner.gpx_file_ids) {
    const wpts = await fetchAndParse(gpxFileId, payload.owner.gc_username);
    for (const w of wpts) ownerWaypoints.set(w.gcCode, w);
  }

  const companionSources: Array<{
    playerId: string;
    lifetime?: import('./types.js').Waypoint[];
    before?: import('./types.js').Waypoint[];
    after?: import('./types.js').Waypoint[];
  }> = [];

  for (const comp of payload.companions ?? []) {
    if (comp.mode === 'lifetime') {
      const wpts = new Map<string, import('./types.js').Waypoint>();
      for (const id of comp.gpx_file_ids) {
        for (const w of await fetchAndParse(id, comp.gc_username)) wpts.set(w.gcCode, w);
      }
      companionSources.push({ playerId: comp.gc_username, lifetime: Array.from(wpts.values()) });
    } else {
      const before = await fetchAndParse(comp.gpx_file_ids[0], comp.gc_username);
      const after  = await fetchAndParse(comp.gpx_file_ids[1], comp.gc_username);
      companionSources.push({ playerId: comp.gc_username, before, after });
    }
  }

  // ── Build TripInput ─────────────────────────────────────────────────────
  const tripInput = {
    version: 1 as const,
    tripName: payload.trip_name,
    startDate: payload.start_date,
    endDate: payload.end_date,
    owner: {
      playerId: userId,
      displayName: payload.owner.display_name,
      gcUsername: payload.owner.gc_username,
    },
    companions: (payload.companions ?? []).map(c => ({
      playerId: c.gc_username,
      displayName: c.display_name,
      gcUsername: c.gc_username,
    })),
    enabledRules: payload.enabled_rules,
    distance: payload.distance_miles ? { miles: payload.distance_miles } : undefined,
    userNotes: payload.user_notes,
  };

  // ── Load reference lists ─────────────────────────────────────────────────
  const refLists = await fetchReferenceListsFromR2(env.REPORT_BUCKET as Parameters<typeof fetchReferenceListsFromR2>[0]);

  // ── Run pipeline ─────────────────────────────────────────────────────────
  const parsedSources = {
    owner: { lifetime: Array.from(ownerWaypoints.values()) },
    companions: companionSources,
  };

  const pipelineResult = await runPipelineFromWaypoints(tripInput, parsedSources, refLists);

  // ── Serialize result to JSON ─────────────────────────────────────────────
  // Sets and Maps need manual serialization
  const serialized = JSON.stringify({
    tripName: pipelineResult.tripInput.tripName,
    startDate: pipelineResult.tripInput.startDate,
    endDate: pipelineResult.tripInput.endDate,
    fieldAvailability: pipelineResult.fieldAvailability,
    warnings: pipelineResult.warnings,
    diagnostics: pipelineResult.diagnostics,
    ownerStats: serializePlayerStats(pipelineResult.ownerStats),
    allPlayerStats: pipelineResult.allPlayerStats.map(serializePlayerStats),
    ruleResults: pipelineResult.ruleResults.map(rr => ({
      rule: { id: rr.rule.id, displayName: rr.rule.displayName, severity: rr.rule.severity },
      matches: rr.matches.map(m => ({
        gcCode: m.waypoint.gcCode,
        name: m.waypoint.name,
        note: m.note,
        favoritePoints: m.waypoint.favoritePoints,
        cacheType: m.waypoint.cacheType,
        difficulty: m.waypoint.difficulty,
        terrain: m.waypoint.terrain,
        findDate: m.waypoint.findDate?.toISOString().slice(0, 10) ?? null,
      })),
    })),
    countiesData: {
      firstTime: [...pipelineResult.countiesData.firstTime],
      previouslyFound: [...pipelineResult.countiesData.previouslyFound],
      stateCoverage: pipelineResult.countiesData.stateCoverage,
    },
    jasmerGridState: Object.fromEntries(pipelineResult.jasmerGridState),
  });

  // ── Store result in R2 ───────────────────────────────────────────────────
  const encoder = new TextEncoder();
  await env.REPORT_BUCKET.put(payload.result_r2_key, encoder.encode(serialized).buffer as ArrayBuffer, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { job_id: jobId, user_id: userId },
  });

  const result: ReportRunResult = {
    result_r2_key: payload.result_r2_key,
    find_count: pipelineResult.ownerStats.aggregate.findsCount,
    companion_count: pipelineResult.allPlayerStats.length - 1,
  };

  // ── Mark job complete ────────────────────────────────────────────────────
  await env.DB.prepare(
    `UPDATE jobs SET status = 'complete', result_json = ?, updated_at = ?, completed_at = ? WHERE job_id = ?`
  ).bind(JSON.stringify(result), ts, ts, jobId).run();

  return result;
}

// ============================================================================
// Serialization helpers
// ============================================================================

function serializePlayerStats(p: import('./types.js').PlayerStats) {
  return {
    playerId: p.playerId,
    displayName: p.displayName,
    role: p.role,
    aggregate: p.aggregate,
    byDay: p.byDay.map(ds => ({
      dayDate: ds.dayDate.toISOString().slice(0, 10),
      finds: ds.finds,
      favoritePoints: ds.favoritePoints,
      newCounties: ds.newCounties,
      byCacheType: ds.byCacheType,
      bestFind: ds.bestFind ? {
        gcCode: ds.bestFind.gcCode,
        name: ds.bestFind.name,
        favoritePoints: ds.bestFind.favoritePoints,
      } : null,
      bestFindReason: ds.bestFindReason,
    })),
  };
}
