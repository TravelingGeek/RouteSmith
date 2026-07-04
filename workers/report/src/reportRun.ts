/**
 * reportRun.ts — Run the REPORT pipeline against GPX files already in R2.
 *
 * Route:
 *   POST /api/report/run-from-r2
 *
 * Request body:
 * {
 *   trip: {
 *     trip_name: string,
 *     start_date: string,   // YYYY-MM-DD
 *     end_date: string,
 *     distance_miles?: number,
 *     user_notes?: string,
 *     enabled_rules?: string[],
 *   },
 *   owner: {
 *     display_name: string,
 *     gc_username: string,
 *     gpx_file_ids: string[],  // active gpx_files rows in R2
 *   },
 *   companions?: Array<{
 *     display_name: string,
 *     gc_username: string,
 *     gpx_file_ids: string[],
 *     mode: 'lifetime' | 'diff',
 *   }>,
 * }
 *
 * Returns the full PipelineResult as JSON.
 */

import type { AuthUser } from './auth.js';
import type { Env } from './types.js';
import type { TripInput } from './types.js';
import { parseGpxTexts } from './gpxParser.js';
import { runPipeline } from './pipeline.js';
import { fetchReferenceListsFromR2 } from './referenceLists.js';
import type { GpxSources } from './pipeline.js';
import { countyKey } from './types.js';

// ============================================================================
// Request types
// ============================================================================

interface RunFromR2Request {
  trip: {
    trip_name: string;
    start_date: string;
    end_date: string;
    distance_miles?: number;
    user_notes?: string;
    enabled_rules?: string[];
  };
  owner: {
    display_name: string;
    gc_username: string;
    gpx_file_ids: string[];
  };
  companions?: Array<{
    display_name: string;
    gc_username: string;
    gpx_file_ids: string[];
    mode: 'lifetime' | 'diff';
  }>;
}

// ============================================================================
// Handler
// ============================================================================

export async function handleReportRunFromR2(
  request: Request,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  let body: RunFromR2Request;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body');
  }

  if (!body.trip?.start_date || !body.trip?.end_date || !body.owner?.gpx_file_ids?.length) {
    return jsonError('trip.start_date, trip.end_date, and owner.gpx_file_ids are required');
  }

  // ── Fetch owner GPX texts from R2 ────────────────────────────────────────

  const ownerTexts = await fetchGpxTexts(body.owner.gpx_file_ids, user.userId, env);
  if (ownerTexts.error || !ownerTexts.texts) return jsonError(ownerTexts.error ?? 'fetch failed', 404);

  // ── Fetch companion GPX texts ─────────────────────────────────────────────

  const companionSources: GpxSources['companions'] = [];
  for (const comp of body.companions ?? []) {
    const compTexts = await fetchGpxTexts(comp.gpx_file_ids, user.userId, env);
    if (compTexts.error || !compTexts.texts) return jsonError(`Companion ${comp.display_name}: ${compTexts.error ?? 'fetch failed'}`, 404);
    const compTextList = compTexts.texts;
    companionSources.push({
      playerId: comp.gc_username,
      lifetime: comp.mode === 'lifetime' ? compTextList : undefined,
      before: comp.mode === 'diff' ? compTextList.slice(0, 1) : undefined,
      after: comp.mode === 'diff' ? compTextList.slice(1) : undefined,
    });
  }

  // ── Build TripInput ───────────────────────────────────────────────────────

  const tripInput: TripInput = {
    version: 1,
    tripName: body.trip.trip_name,
    startDate: body.trip.start_date,
    endDate: body.trip.end_date,
    owner: {
      playerId: user.userId,
      displayName: body.owner.display_name,
      gcUsername: body.owner.gc_username,
    },
    companions: (body.companions ?? []).map(c => ({
      playerId: c.gc_username,
      displayName: c.display_name,
      gcUsername: c.gc_username,
    })),
    enabledRules: body.trip.enabled_rules,
    distance: body.trip.distance_miles ? { miles: body.trip.distance_miles } : undefined,
    userNotes: body.trip.user_notes,
  };

  // ── Build GpxSources ─────────────────────────────────────────────────────

  const gpxSources: GpxSources = {
    owner: { lifetime: ownerTexts.texts as string[] },
    companions: companionSources,
  };

  // ── Load reference lists ──────────────────────────────────────────────────

  const refLists = await fetchReferenceListsFromR2(env.REPORT_BUCKET);

  // ── Run pipeline ──────────────────────────────────────────────────────────

  let result;
  try {
    result = await runPipeline(tripInput, gpxSources, refLists);
  } catch (e) {
    return jsonError(`Pipeline error: ${(e as Error).message}`, 500);
  }

  // ── Serialize and return ──────────────────────────────────────────────────

  return new Response(
    JSON.stringify({
      tripName: result.tripInput.tripName,
      startDate: result.tripInput.startDate,
      endDate: result.tripInput.endDate,
      fieldAvailability: result.fieldAvailability,
      warnings: result.warnings,
      diagnostics: result.diagnostics,
      ownerStats: {
        playerId: result.ownerStats.playerId,
        displayName: result.ownerStats.displayName,
        aggregate: result.ownerStats.aggregate,
        byDay: result.ownerStats.byDay.map(ds => ({
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
        })),
      },
      ruleResults: result.ruleResults.map(rr => ({
        rule: { id: rr.rule.id, displayName: rr.rule.displayName, severity: rr.rule.severity },
        matches: rr.matches.map(m => ({
          gcCode: m.waypoint.gcCode,
          name: m.waypoint.name,
          note: m.note,
        })),
      })),
      countiesData: {
        firstTime: [...result.countiesData.firstTime],
        previouslyFound: [...result.countiesData.previouslyFound],
        stateCoverage: result.countiesData.stateCoverage,
      },
      jasmerGridState: Object.fromEntries(result.jasmerGridState),
    }, null, 2),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

// ============================================================================
// R2 fetch helper
// ============================================================================

async function fetchGpxTexts(
  gpxFileIds: string[],
  userId: string,
  env: Env,
): Promise<{ texts: string[]; error?: undefined } | { texts?: undefined; error: string }> {
  const texts: string[] = [];

  for (const gpxFileId of gpxFileIds) {
    // Look up the R2 key from D1 — validate ownership
    const row = await env.DB
      .prepare(`
        SELECT gf.r2_key, gf.scope
        FROM gpx_files gf
        JOIN finders f ON f.finder_id = gf.owner_finder_id
        WHERE gf.gpx_file_id = ?
          AND f.owner_user_id = ?
          AND gf.is_active = 1
          AND gf.deleted_at IS NULL
      `)
      .bind(gpxFileId, userId)
      .first<{ r2_key: string; scope: string }>();

    if (!row) {
      return { error: `GPX file not found or not accessible: ${gpxFileId}` };
    }

    // Fetch from R2
    const obj = await env.REPORT_BUCKET.get(row.r2_key);
    if (!obj) {
      return { error: `R2 object missing for file ${gpxFileId}` };
    }

    // Decompress if ZIP
    const buffer = await obj.arrayBuffer();
    if (row.r2_key.toLowerCase().endsWith('.zip')) {
      const { unzipSync } = await import('fflate');
      const files = unzipSync(new Uint8Array(buffer));
      const gpxEntries = Object.entries(files)
        .filter(([n]) => n.toLowerCase().endsWith('.gpx') && !n.toLowerCase().includes('wpts'));
      if (!gpxEntries.length) return { error: `ZIP ${gpxFileId} contains no .gpx files` };
      const decoder = new TextDecoder('utf-8');
      for (const [, data] of gpxEntries) {
        texts.push(decoder.decode(data));
      }
    } else {
      texts.push(new TextDecoder('utf-8').decode(buffer));
    }
  }

  return { texts };
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
