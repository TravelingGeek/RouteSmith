/**
 * gpxParseJob.ts — GPX parse job handler for the routesmith-jobs consumer.
 *
 * Runs in the Queue consumer Worker where there is no CPU time limit.
 * Fetches the GPX file from R2, parses it, updates D1.
 *
 * On non-retryable errors (bad file, parse failure): marks job failed,
 * updates gpx_files status, writes audit event. Does NOT throw — prevents
 * Cloudflare from re-queuing.
 *
 * On retryable errors (R2/D1 unavailable): throws so Cloudflare retries.
 */

import type { Env, GpxParsePayload, GpxParseResult, D1PreparedStatement } from './types.js';

const MAX_ATTEMPTS = 3;

export async function handleGpxParseJob(
  jobId: string,
  userId: string,
  payload: GpxParsePayload,
  attemptNumber: number,
  env: Env,
): Promise<GpxParseResult> {
  const { gpx_file_id, finder_id, r2_key, file_role } = payload;
  const ts = Math.floor(Date.now() / 1000);

  // Mark job as processing
  await env.DB.prepare(`
    UPDATE jobs
    SET status = 'processing', attempt_count = ?, updated_at = ?
    WHERE job_id = ?
  `).bind(attemptNumber, ts, jobId).run();

  // Fetch file from R2 — retryable if unavailable
  const r2Object = await env.REPORT_BUCKET.get(r2_key);
  if (!r2Object) {
    // File missing — non-retryable (won't appear on retry either)
    await markJobFailed(env, jobId, gpx_file_id, userId,
      `R2 object not found: ${r2_key}`, ts, false);
    throw new Error(`R2 object not found: ${r2_key} — marked failed, not retrying`);
  }

  // Parse the GPX
  let findCount: number;
  let dataThrough: string | null;
  let detectedFormat: string;

  try {
    const arrayBuffer = await r2Object.arrayBuffer();
    const gpxTexts = await decompressToTexts(arrayBuffer, r2_key);
    let latestDate: string | null = null;
    let totalFinds = 0;
    let format = 'unknown';

    for (const text of gpxTexts) {
      const meta = extractGpxMetadata(text);
      totalFinds += meta.findCount;
      if (meta.format !== 'unknown') format = meta.format;
      if (meta.dataThrough && (!latestDate || meta.dataThrough > latestDate)) {
        latestDate = meta.dataThrough;
      }
    }

    findCount      = totalFinds;
    dataThrough    = latestDate;
    detectedFormat = format;
  } catch (e) {
    // Parse error — non-retryable
    const msg = `GPX parse failed: ${(e as Error).message}`;
    await markJobFailed(env, jobId, gpx_file_id, userId, msg, ts, false);
    throw new Error(`${msg} — marked failed, not retrying`);
  }

  // Find any currently active file for this finder+role+scope to supersede
  const previousActive = await env.DB
    .prepare(`
      SELECT gpx_file_id, r2_key
      FROM gpx_files
      WHERE owner_finder_id = ?
        AND file_role = ?
        AND scope = ?
        AND is_active = 1
        AND deleted_at IS NULL
        AND gpx_file_id != ?
    `)
    .bind(finder_id, file_role, payload.scope, gpx_file_id)
    .first<{ gpx_file_id: string; r2_key: string }>();

  // Build batch D1 statements
  const statements: D1PreparedStatement[] = [];

  // 1. Activate the new file
  statements.push(
    env.DB.prepare(`
      UPDATE gpx_files
      SET is_active = 1, find_count = ?, data_through = ?,
          format = ?, parsed_at = ?
      WHERE gpx_file_id = ?
    `).bind(findCount, dataThrough, detectedFormat, ts, gpx_file_id)
  );

  // 2. Deactivate previous file
  if (previousActive) {
    statements.push(
      env.DB.prepare(`
        UPDATE gpx_files
        SET is_active = 0, deleted_at = ?, deleted_by_user_id = ?
        WHERE gpx_file_id = ?
      `).bind(ts, userId, previousActive.gpx_file_id)
    );

    statements.push(
      env.DB.prepare(`
        INSERT INTO gpx_file_events (
          event_id, gpx_file_id, event_type, executed_by_user_id,
          related_gpx_file_id, note, occurred_at
        ) VALUES (?, ?, 'replaced', ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        previousActive.gpx_file_id,
        userId,
        gpx_file_id,
        `Superseded by upload of ${r2_key} (${findCount} finds)`,
        ts,
      )
    );
  }

  // 3. Audit: uploaded event
  statements.push(
    env.DB.prepare(`
      INSERT INTO gpx_file_events (
        event_id, gpx_file_id, event_type, executed_by_user_id,
        note, occurred_at
      ) VALUES (?, ?, 'uploaded', ?, ?, ?)
    `).bind(
      crypto.randomUUID(), gpx_file_id, userId,
      `${findCount} finds, format: ${detectedFormat}`, ts,
    )
  );

  // 4. Audit: parsed event
  statements.push(
    env.DB.prepare(`
      INSERT INTO gpx_file_events (
        event_id, gpx_file_id, event_type, executed_by_user_id,
        note, occurred_at
      ) VALUES (?, ?, 'parsed', ?, ?, ?)
    `).bind(
      crypto.randomUUID(), gpx_file_id, userId,
      `${findCount} finds · data through ${dataThrough ?? 'unknown'}`, ts,
    )
  );

  // 5. Update finder freshness (lifetime role only)
  if (file_role === 'lifetime') {
    statements.push(
      env.DB.prepare(`
        UPDATE finders
        SET lifetime_uploaded_at = ?,
            lifetime_find_count = ?,
            lifetime_data_through = ?,
            updated_at = ?
        WHERE finder_id = ?
      `).bind(ts, findCount, dataThrough, ts, finder_id)
    );
  }

  // 6. Mark job complete
  const result: GpxParseResult = {
    find_count: findCount,
    data_through: dataThrough,
    format: detectedFormat,
    superseded_file_id: previousActive?.gpx_file_id ?? null,
  };

  statements.push(
    env.DB.prepare(`
      UPDATE jobs
      SET status = 'complete', result_json = ?, updated_at = ?, completed_at = ?
      WHERE job_id = ?
    `).bind(JSON.stringify(result), ts, ts, jobId)
  );

  // Execute batch — retryable if D1 is unavailable
  await env.DB.batch(statements);

  return result;
}

// ============================================================================
// Failure helper
// ============================================================================

async function markJobFailed(
  env: Env,
  jobId: string,
  gpxFileId: string,
  userId: string,
  error: string,
  ts: number,
  retryable: boolean,
): Promise<void> {
  if (retryable) return; // let Cloudflare retry; don't mark failed yet

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE jobs
      SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
      WHERE job_id = ?
    `).bind(error, ts, ts, jobId),

    env.DB.prepare(`
      INSERT INTO gpx_file_events (
        event_id, gpx_file_id, event_type, executed_by_user_id,
        note, occurred_at
      ) VALUES (?, ?, 'parse_failed', ?, ?, ?)
    `).bind(crypto.randomUUID(), gpxFileId, userId, error, ts),
  ]);
}

// ============================================================================
// GPX metadata extractor — regex-based, memory-efficient
// Processes GPX text without building a full parse tree.
// Extracts only find counts and dates from log entries.
// ============================================================================

function extractGpxMetadata(gpxText: string): {
  findCount: number;
  dataThrough: string | null;
  format: string;
} {
  // Format detection — check first 2000 chars only
  const header = gpxText.slice(0, 2000);
  let format = 'unknown';
  if (header.includes('gsak.net')) format = 'pgc';
  else if (header.includes('geocaching.com') || header.includes('Groundspeak')) format = 'gccom';

  // Extract all <groundspeak:log> blocks efficiently
  // We scan for "Found it", "Attended", or "Webcam Photo Taken" log types
  // and extract the associated date. One pass through the string.
  const FOUND_TYPES = new Set(['Found it', 'Attended', 'Webcam Photo Taken']);

  // Regex to match a log block — non-greedy, captures type and date
  // Works on both groundspeak:log and gs:log namespace prefixes
  const logBlockRe = /<(?:groundspeak|gs):log[^>]*>([\s\S]*?)<\/(?:groundspeak|gs):log>/g;
  const typeRe     = /<(?:groundspeak|gs):type[^>]*>([^<]+)<\/(?:groundspeak|gs):type>/;
  const dateRe     = /<(?:groundspeak|gs):date[^>]*>([^<]+)<\/(?:groundspeak|gs):date>/;

  let findCount = 0;
  let latestDate: string | null = null;

  // Track which <wpt> we're in so we only count one find per cache
  // Strategy: reset "counted this wpt" flag whenever we see </wpt>
  // We scan log blocks and use a Set of already-counted positions
  const wptBoundaryRe = /<\/wpt>/g;
  const wptPositions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = wptBoundaryRe.exec(gpxText)) !== null) {
    wptPositions.push(m.index);
  }

  let wptIdx = 0; // index into wptPositions
  let lastWptEnd = -1;

  while ((m = logBlockRe.exec(gpxText)) !== null) {
    const logBlock = m[1];
    const logPos   = m.index;

    // Advance wpt boundary pointer
    while (wptIdx < wptPositions.length && wptPositions[wptIdx] < logPos) {
      lastWptEnd = wptPositions[wptIdx];
      wptIdx++;
    }

    const typeMatch = typeRe.exec(logBlock);
    if (!typeMatch) continue;
    const logType = typeMatch[1].trim();
    if (!FOUND_TYPES.has(logType)) continue;

    // Only count first matching log per wpt (logs are in reverse-chron order
    // in PGC exports; first match = most recent = the find log)
    findCount++;

    const dateMatch = dateRe.exec(logBlock);
    if (dateMatch) {
      const dateStr = dateMatch[1].trim().slice(0, 10); // YYYY-MM-DD
      if (!latestDate || dateStr > latestDate) latestDate = dateStr;
    }

    // Skip remaining logs in this wpt by jumping past the next </wpt>
    if (wptIdx < wptPositions.length) {
      logBlockRe.lastIndex = wptPositions[wptIdx] + 6; // past </wpt>
    }
  }

  return { findCount, dataThrough: latestDate, format };
}

async function decompressToTexts(buffer: ArrayBuffer, r2Key: string): Promise<string[]> {
  if (r2Key.toLowerCase().endsWith('.zip')) {
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(buffer));
    const gpxEntries = Object.entries(files).filter(([n]) => n.toLowerCase().endsWith('.gpx'));
    if (!gpxEntries.length) throw new Error('ZIP contains no .gpx files');
    const decoder = new TextDecoder('utf-8');
    return gpxEntries.map(([, data]) => decoder.decode(data));
  }
  return [new TextDecoder('utf-8').decode(buffer)];
}
