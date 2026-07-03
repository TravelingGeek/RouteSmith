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
      const meta = await extractGpxMetadata(text);
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
// GPX metadata extractor (Workers-compatible, no DOMParser)
// ============================================================================

async function extractGpxMetadata(gpxText: string): Promise<{
  findCount: number;
  dataThrough: string | null;
  format: string;
}> {
  const { XMLParser } = await import('fast-xml-parser');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name: string) => name === 'wpt' || name === 'log',
    parseAttributeValue: true,
    processEntities: {
      enabled: true,
      maxEntityCount: 100000,
    } as unknown as boolean,
    htmlEntities: false,
  });

  const doc = parser.parse(gpxText);

  const raw = JSON.stringify(doc);
  let format = 'unknown';
  if (raw.includes('gsak.net')) format = 'pgc';
  else if (raw.includes('geocaching.com') || raw.includes('Groundspeak')) format = 'gccom';

  const root = doc.gpx ?? doc['gpx:gpx'] ?? Object.values(doc)[0];
  const wpts: unknown[] = root?.wpt ?? [];

  if (!Array.isArray(wpts) || wpts.length === 0) {
    return { findCount: 0, dataThrough: null, format };
  }

  let latest: Date | null = null;
  let findCount = 0;

  for (const wpt of wpts) {
    if (typeof wpt !== 'object' || wpt === null) continue;
    const w = wpt as Record<string, unknown>;
    const cacheNode = findNode(w, 'cache');
    if (!cacheNode) continue;
    const logsNode = findNode(cacheNode as Record<string, unknown>, 'logs');
    if (!logsNode) continue;
    const logs = findArray(logsNode as Record<string, unknown>, 'log');

    for (const log of logs) {
      const logObj = log as Record<string, unknown>;
      const logType = findText(logObj, 'type') ?? '';
      if (!['Found it', 'Attended', 'Webcam Photo Taken'].includes(logType)) continue;
      findCount++;
      const dateStr = findText(logObj, 'date');
      if (dateStr) {
        const d = new Date(dateStr.trim());
        if (!isNaN(d.getTime()) && (!latest || d > latest)) latest = d;
      }
      break;
    }
  }

  return {
    findCount,
    dataThrough: latest ? latest.toISOString().slice(0, 10) : null,
    format,
  };
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

function findNode(obj: Record<string, unknown>, localName: string): unknown {
  for (const key of Object.keys(obj)) {
    const stripped = key.includes(':') ? key.split(':').pop()! : key;
    if (stripped === localName) return obj[key];
  }
  return null;
}

function findText(obj: Record<string, unknown>, localName: string): string | null {
  const val = findNode(obj, localName);
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    const o = val as Record<string, unknown>;
    if ('#text' in o) return String(o['#text']);
  }
  return null;
}

function findArray(obj: Record<string, unknown>, localName: string): unknown[] {
  const val = findNode(obj, localName);
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}
