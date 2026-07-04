/**
 * gpxParseJob.ts — GPX parse job handler for the routesmith-jobs consumer.
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

  await env.DB.prepare(`
    UPDATE jobs SET status = 'processing', attempt_count = ?, updated_at = ?
    WHERE job_id = ?
  `).bind(attemptNumber, ts, jobId).run();

  const r2Object = await env.REPORT_BUCKET.get(r2_key);
  if (!r2Object) {
    await markJobFailed(env, jobId, gpx_file_id, userId, `R2 object not found: ${r2_key}`, ts);
    throw new Error(`R2 object not found — marked failed, not retrying`);
  }

  let findCount: number;
  let dataThrough: string | null;
  let detectedFormat: string;
  let detectedUsername: string | null = null;

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
      if (meta.detectedUsername && !detectedUsername) detectedUsername = meta.detectedUsername;
    }

    findCount      = totalFinds;
    dataThrough    = latestDate;
    detectedFormat = format;

    // Option B: validate detected username against finder's gc_username
    // Option A: warn on dramatic find count drop (secondary check)
    if (detectedUsername) {
      const finder = await env.DB
        .prepare('SELECT gc_username, lifetime_find_count FROM finders WHERE finder_id = ?')
        .bind(finder_id)
        .first<{ gc_username: string | null; lifetime_find_count: number | null }>();

      if (finder?.gc_username) {
        const expected = finder.gc_username.toLowerCase();
        const detected = detectedUsername.toLowerCase();
        if (expected !== detected) {
          const msg = `Username mismatch: file contains finds for '${detectedUsername}' but this finder is '${finder.gc_username}'. Upload rejected.`;
          await markJobFailed(env, jobId, gpx_file_id, userId, msg, ts);
          throw new Error(`${msg} — marked failed, not retrying`);
        }
      }

      // Option A: count drop warning (catches wrong file even if gc_username not set)
      const existingCount = finder?.lifetime_find_count ?? 0;
      if (existingCount > 100 && findCount < existingCount * 0.5) {
        const msg = `Find count dropped dramatically: file has ${findCount} finds but existing lifetime data has ${existingCount}. This may be the wrong file. Upload rejected.`;
        await markJobFailed(env, jobId, gpx_file_id, userId, msg, ts);
        throw new Error(`${msg} — marked failed, not retrying`);
      }
    }
  } catch (e) {
    const errMsg = (e as Error).message;
    if (errMsg.includes('not retrying')) throw e; // already handled
    const msg = `GPX parse failed: ${errMsg}`;
    await markJobFailed(env, jobId, gpx_file_id, userId, msg, ts);
    throw new Error(`${msg} — marked failed, not retrying`);
  }

  const previousActive = await env.DB
    .prepare(`
      SELECT gpx_file_id, r2_key FROM gpx_files
      WHERE owner_finder_id = ? AND file_role = ? AND scope = ?
        AND is_active = 1 AND deleted_at IS NULL AND gpx_file_id != ?
    `)
    .bind(finder_id, file_role, payload.scope, gpx_file_id)
    .first<{ gpx_file_id: string; r2_key: string }>();

  const statements: D1PreparedStatement[] = [];

  statements.push(env.DB.prepare(`
    UPDATE gpx_files SET is_active = 1, find_count = ?, data_through = ?, format = ?, parsed_at = ?
    WHERE gpx_file_id = ?
  `).bind(findCount, dataThrough, detectedFormat, ts, gpx_file_id));

  if (previousActive) {
    statements.push(env.DB.prepare(`
      UPDATE gpx_files SET is_active = 0, deleted_at = ?, deleted_by_user_id = ?
      WHERE gpx_file_id = ?
    `).bind(ts, userId, previousActive.gpx_file_id));

    statements.push(env.DB.prepare(`
      INSERT INTO gpx_file_events (event_id, gpx_file_id, event_type, executed_by_user_id, related_gpx_file_id, note, occurred_at)
      VALUES (?, ?, 'replaced', ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), previousActive.gpx_file_id, userId, gpx_file_id,
        `Superseded by ${r2_key} (${findCount} finds)`, ts));
  }

  statements.push(env.DB.prepare(`
    INSERT INTO gpx_file_events (event_id, gpx_file_id, event_type, executed_by_user_id, note, occurred_at)
    VALUES (?, ?, 'uploaded', ?, ?, ?)
  `).bind(crypto.randomUUID(), gpx_file_id, userId, `${findCount} finds, format: ${detectedFormat}`, ts));

  statements.push(env.DB.prepare(`
    INSERT INTO gpx_file_events (event_id, gpx_file_id, event_type, executed_by_user_id, note, occurred_at)
    VALUES (?, ?, 'parsed', ?, ?, ?)
  `).bind(crypto.randomUUID(), gpx_file_id, userId,
      `${findCount} finds · data through ${dataThrough ?? 'unknown'}`, ts));

  if (file_role === 'lifetime') {
    statements.push(env.DB.prepare(`
      UPDATE finders SET lifetime_uploaded_at = ?, lifetime_find_count = ?, lifetime_data_through = ?, updated_at = ?
      WHERE finder_id = ?
    `).bind(ts, findCount, dataThrough, ts, finder_id));
  }

  const result: GpxParseResult = {
    find_count: findCount,
    data_through: dataThrough,
    format: detectedFormat,
    superseded_file_id: previousActive?.gpx_file_id ?? null,
  };

  statements.push(env.DB.prepare(`
    UPDATE jobs SET status = 'complete', result_json = ?, updated_at = ?, completed_at = ?
    WHERE job_id = ?
  `).bind(JSON.stringify(result), ts, ts, jobId));

  await env.DB.batch(statements);
  return result;
}

async function markJobFailed(
  env: Env, jobId: string, gpxFileId: string, userId: string, error: string, ts: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE job_id = ?
    `).bind(error, ts, ts, jobId),
    env.DB.prepare(`
      INSERT INTO gpx_file_events (event_id, gpx_file_id, event_type, executed_by_user_id, note, occurred_at)
      VALUES (?, ?, 'parse_failed', ?, ?, ?)
    `).bind(crypto.randomUUID(), gpxFileId, userId, error, ts),
  ]);
}

// ============================================================================
// GPX metadata extractor — split on </wpt> boundaries, no regex state issues
// ============================================================================

function extractGpxMetadata(gpxText: string): {
  findCount: number;
  dataThrough: string | null;
  format: string;
  detectedUsername: string | null;
} {
  const header = gpxText.slice(0, 10000);
  let format = 'unknown';
  if (header.includes('gsak.net') || header.includes('Project-GC') || header.includes('project-gc.com')) {
    format = 'pgc';
  } else if (header.includes('geocaching.com') || header.includes('Groundspeak')) {
    format = 'gccom';
  }

  console.log(`[extractGpxMetadata] format=${format} textLen=${gpxText.length}`);

  const FOUND_TYPES = new Set(['Found it', 'Attended', 'Webcam Photo Taken']);
  let findCount = 0;
  let latestDate: string | null = null;

  if (format === 'pgc') {
    const wptChunks = gpxText.split('</wpt>');
    console.log(`[extractGpxMetadata] pgc chunks=${wptChunks.length}`);

    for (const chunk of wptChunks) {
      const logsStart = chunk.indexOf('<groundspeak:logs>');
      if (logsStart === -1) continue;
      const logsSection = chunk.slice(logsStart);
      const logChunks = logsSection.split('</groundspeak:log>');
      let counted = false;

      for (const log of logChunks) {
        if (counted) break;
        const typeOpen  = log.indexOf('<groundspeak:type>');
        const typeClose = log.indexOf('</groundspeak:type>');
        if (typeOpen === -1 || typeClose === -1) continue;
        const logType = log.slice(typeOpen + 18, typeClose).trim();
        if (!FOUND_TYPES.has(logType)) continue;

        findCount++;
        counted = true;

        const dateOpen  = log.indexOf('<groundspeak:date>');
        const dateClose = log.indexOf('</groundspeak:date>');
        if (dateOpen !== -1 && dateClose !== -1) {
          const dateStr = log.slice(dateOpen + 18, dateClose).trim().slice(0, 10);
          if (dateStr && (!latestDate || dateStr > latestDate)) latestDate = dateStr;
        }
      }
    }
  } else {
    // gc.com format: sym contains "Found", time element is find date
    const wptChunks = gpxText.split('</wpt>');
    console.log(`[extractGpxMetadata] gccom chunks=${wptChunks.length}`);

    for (const chunk of wptChunks) {
      const symOpen  = chunk.indexOf('<sym>');
      const symClose = chunk.indexOf('</sym>');
      if (symOpen === -1 || symClose === -1) continue;
      const sym = chunk.slice(symOpen + 5, symClose).trim();
      if (!sym.includes('Found')) continue;

      findCount++;
      const timeOpen  = chunk.indexOf('<time>');
      const timeClose = chunk.indexOf('</time>');
      if (timeOpen !== -1 && timeClose !== -1) {
        const dateStr = chunk.slice(timeOpen + 6, timeClose).trim().slice(0, 10);
        if (dateStr && (!latestDate || dateStr > latestDate)) latestDate = dateStr;
      }
    }
  }

  // Extract the most common finder username from log entries
  let detectedUsername: string | null = null;
  const finderRe = /<groundspeak:finder[^>]*>([^<]+)<\/groundspeak:finder>/g;
  const finderCounts = new Map<string, number>();
  let fm: RegExpExecArray | null;
  while ((fm = finderRe.exec(gpxText)) !== null) {
    const name = fm[1].trim();
    finderCounts.set(name, (finderCounts.get(name) ?? 0) + 1);
  }
  if (finderCounts.size > 0) {
    detectedUsername = [...finderCounts.entries()]
      .sort((a, b) => b[1] - a[1])[0][0];
  }

  console.log(`[extractGpxMetadata] findCount=${findCount} dataThrough=${latestDate} detectedUsername=${detectedUsername}`);
  return { findCount, dataThrough: latestDate, format, detectedUsername };
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
