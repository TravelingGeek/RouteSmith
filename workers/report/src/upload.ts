/**
 * upload.ts — GPX file upload endpoints for the Routesmith REPORT Worker.
 *
 * Flow:
 *   1. POST /api/upload/presign   — validate, create gpx_files row, return R2 presigned URL
 *   2. PUT  (browser → R2 direct) — browser uploads file bytes straight to R2
 *   3. POST /api/upload/confirm   — parse GPX, update gpx_files, write audit events
 *
 * Two contexts:
 *   - Owner lifetime upload (no trip_id): finder_id = 'finder_{user_id}'
 *   - Companion lifetime upload (no trip_id): finder_id supplied explicitly
 *
 * Both contexts use the same endpoints; the difference is which finder_id
 * is passed in the request body.
 *
 * Trip authorization (gpx_file_trip_auth) is written during confirm if
 * trip_id is supplied. It is optional — companion lifetime files may be
 * uploaded without a trip context.
 */

import type { AuthUser } from './auth.js';
import type { JobMessage } from './types.js';

// ============================================================================
// Environment
// ============================================================================

import type { R2Bucket, R2ObjectBody, D1Database, D1PreparedStatement, D1Result, Env } from './types.js';
export type UploadEnv = Env;

// ============================================================================
// Helpers
// ============================================================================

function uuid(): string {
  // crypto.randomUUID() is available in Workers runtime
  return crypto.randomUUID();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// R2 key convention:
//   gpx/{finder_id}/{role}/{scope}/{uuid}.{ext}
// e.g. gpx/finder_user_abc/lifetime/full/f3a1bc.zip
function buildR2Key(
  finderId: string,
  role: string,
  scope: string,
  ext: string,
): string {
  return `gpx/${finderId}/${role}/${scope}/${uuid()}.${ext}`;
}

// ============================================================================
// POST /api/upload/presign
// ============================================================================

interface PresignRequest {
  finder_id?: string;       // omit to use caller's own finder
  file_role?: string;       // 'lifetime' | 'before' | 'after' — default 'lifetime'
  scope?: string;           // 'full' | 'incremental' — default 'full'
  filename: string;         // original filename from browser (for ext detection)
  file_size_bytes: number;
  trip_id?: string;         // optional — if supplied, auth row will be written on confirm
}

/**
 * Step 1: Validate the request, create a gpx_files row in 'pending' state,
 * return an R2 presigned PUT URL for the browser to upload to directly.
 *
 * We use a time-limited signed URL so the Worker never handles the file bytes
 * on upload (only on confirm/parse). The browser uploads directly to R2.
 *
 * Note: Cloudflare R2 presigned URLs require the bucket to have public
 * access or a custom domain bound. For Workers-managed uploads we instead
 * return the R2 key and let the Worker act as the upload proxy on confirm.
 * See UPLOAD_NOTES below.
 */
export async function handlePresign(
  request: Request,
  user: AuthUser,
  env: UploadEnv,
): Promise<Response> {
  let body: PresignRequest;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body');
  }

  const { filename, file_size_bytes, trip_id } = body;
  const file_role = body.file_role ?? 'lifetime';
  const scope     = body.scope     ?? 'full';

  if (!filename) return jsonError('filename is required');
  if (!file_size_bytes || file_size_bytes <= 0) return jsonError('file_size_bytes is required');
  if (file_size_bytes > 150 * 1024 * 1024) return jsonError('File too large (max 150MB)');

  const validRoles  = ['lifetime', 'before', 'after'];
  const validScopes = ['full', 'incremental'];
  if (!validRoles.includes(file_role))  return jsonError(`Invalid file_role: ${file_role}`);
  if (!validScopes.includes(scope))     return jsonError(`Invalid scope: ${scope}`);

  // Resolve finder_id
  const finderId = body.finder_id ?? `finder_${user.userId}`;

  // Verify the caller owns or has access to this finder
  const finder = await env.DB
    .prepare('SELECT finder_id, owner_user_id FROM finders WHERE finder_id = ?')
    .bind(finderId)
    .first<{ finder_id: string; owner_user_id: string }>();

  if (!finder) return jsonError('Finder not found', 404);
  if (finder.owner_user_id !== user.userId) {
    return jsonError('Not authorized to upload for this finder', 403);
  }

  // Validate trip_id if supplied
  if (trip_id) {
    const trip = await env.DB
      .prepare('SELECT trip_id, user_id FROM trips WHERE trip_id = ?')
      .bind(trip_id)
      .first<{ trip_id: string; user_id: string }>();
    if (!trip) return jsonError('Trip not found', 404);
    if (trip.user_id !== user.userId) return jsonError('Not authorized for this trip', 403);
  }

  // Determine file extension
  const lowerName = filename.toLowerCase();
  const ext = lowerName.endsWith('.zip') ? 'zip'
            : lowerName.endsWith('.gpx') ? 'gpx'
            : null;
  if (!ext) return jsonError('File must be .gpx or .zip');

  const format = ext === 'zip' ? 'pgc' : 'unknown'; // refined on confirm after parse
  const r2Key  = buildR2Key(finderId, file_role, scope, ext);
  const ts     = now();
  const gpxFileId = uuid();

  // Create gpx_files row in pending state (is_active = 0 until confirmed)
  await env.DB
    .prepare(`
      INSERT INTO gpx_files (
        gpx_file_id, owner_finder_id, uploaded_by_user_id,
        file_role, scope, r2_key, format,
        file_size_bytes, is_active, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `)
    .bind(gpxFileId, finderId, user.userId, file_role, scope, r2Key, format, file_size_bytes, ts)
    .run();

  // Return upload token to browser
  // The browser will POST the file to /api/upload/data/{gpx_file_id}
  // which proxies it to R2. See UPLOAD_NOTES.
  return jsonResponse({
    gpx_file_id: gpxFileId,
    r2_key: r2Key,
    upload_url: `/api/upload/data/${gpxFileId}`,
    expires_in_seconds: 900,  // 15 minutes
  }, 201);
}

// ============================================================================
// PUT /api/upload/data/:gpx_file_id
// ============================================================================

/**
 * Step 2 (proxy): Receive the raw file bytes from the browser and stream
 * them to R2. This is simpler than presigned URLs for our deployment model
 * since our Worker is on the same Cloudflare account as the R2 bucket.
 *
 * The Worker streams the body directly to R2 without buffering the full
 * file in memory, keeping memory usage low even for large GPX files.
 */
export async function handleUploadData(
  request: Request,
  user: AuthUser,
  env: UploadEnv,
  gpxFileId: string,
): Promise<Response> {
  // Look up the pending file record
  const fileRow = await env.DB
    .prepare(`
      SELECT gpx_file_id, owner_finder_id, uploaded_by_user_id,
             r2_key, is_active, uploaded_at
      FROM gpx_files
      WHERE gpx_file_id = ? AND is_active = 0 AND deleted_at IS NULL
    `)
    .bind(gpxFileId)
    .first<{
      gpx_file_id: string;
      owner_finder_id: string;
      uploaded_by_user_id: string;
      r2_key: string;
      is_active: number;
      uploaded_at: number;
    }>();

  if (!fileRow) return jsonError('Upload session not found or already confirmed', 404);
  if (fileRow.uploaded_by_user_id !== user.userId) {
    return jsonError('Not authorized', 403);
  }

  // Check upload hasn't expired (15 min)
  if (now() - fileRow.uploaded_at > 900) {
    return jsonError('Upload session expired. Request a new presign.', 410);
  }

  if (!request.body) return jsonError('Request body is empty');

  // Stream to R2
  try {
    const contentType = request.headers.get('Content-Type') ?? 'application/octet-stream';
    await env.REPORT_BUCKET.put(fileRow.r2_key, request.body, {
      httpMetadata: { contentType },
      customMetadata: {
        gpx_file_id: gpxFileId,
        uploaded_by: user.userId,
        finder_id: fileRow.owner_finder_id,
      },
    });
  } catch (e) {
    return jsonError(`R2 upload failed: ${(e as Error).message}`, 500);
  }

  return jsonResponse({ status: 'uploaded', gpx_file_id: gpxFileId });
}

// ============================================================================
// POST /api/upload/confirm/:gpx_file_id
// ============================================================================

/**
 * Step 3: Parse the uploaded GPX, extract metadata, activate the file,
 * deactivate any previous file for this finder+role+scope, write audit events.
 */
export async function handleConfirm(
  request: Request,
  user: AuthUser,
  env: UploadEnv,
  gpxFileId: string,
): Promise<Response> {
  interface ConfirmRequest {
    trip_id?: string;
    gc_username?: string;
    // Browser-extracted metadata (replaces queue-based parsing)
    find_count?: number;
    data_through?: string | null;
    format?: string;
    detected_username?: string | null;
    finds?: Array<{
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
    }>;
    counties?: Array<{
      county: string;
      state: string;
      country: string;
      firstFound: string;  // ISO date YYYY-MM-DD
    }>;
  }

  let body: ConfirmRequest = {};
  try {
    body = await request.json();
  } catch { /* body is optional */ }

  // Look up the pending file
  const fileRow = await env.DB
    .prepare(`
      SELECT gpx_file_id, owner_finder_id, uploaded_by_user_id,
             r2_key, file_role, scope, file_size_bytes
      FROM gpx_files
      WHERE gpx_file_id = ? AND is_active = 0 AND deleted_at IS NULL
    `)
    .bind(gpxFileId)
    .first<{
      gpx_file_id: string;
      owner_finder_id: string;
      uploaded_by_user_id: string;
      r2_key: string;
      file_role: string;
      scope: string;
      file_size_bytes: number;
    }>();

  if (!fileRow) return jsonError('Upload session not found or already confirmed', 404);
  if (fileRow.uploaded_by_user_id !== user.userId) {
    return jsonError('Not authorized', 403);
  }

  // Fetch the file from R2
  const r2Object = await env.REPORT_BUCKET.get(fileRow.r2_key);
  if (!r2Object) {
    return jsonError('File not found in storage. Was the upload completed?', 404);
  }

  const ts = now();

  // Use browser-supplied metadata — no queue job needed.
  // The browser extracted find_count, data_through, format, and detected_username
  // during file selection using the same regex logic as the former queue job.
  const findCount    = body.find_count ?? null;
  const dataThrough  = body.data_through ?? null;
  const detectedFormat = body.format ?? 'unknown';
  const gcUsername   = body.gc_username ?? body.detected_username ?? null;

  // Find any currently active file for this finder+role+scope to supersede
  const previousActive = await env.DB
    .prepare(`
      SELECT gpx_file_id FROM gpx_files
      WHERE owner_finder_id = ? AND file_role = ? AND scope = ?
        AND is_active = 1 AND deleted_at IS NULL
    `)
    .bind(fileRow.owner_finder_id, fileRow.file_role, fileRow.scope)
    .first<{ gpx_file_id: string }>();

  const statements: D1PreparedStatement[] = [];

  // Activate new file with browser-supplied metadata
  statements.push(env.DB.prepare(`
    UPDATE gpx_files
    SET is_active = 1, find_count = ?, data_through = ?, format = ?, parsed_at = ?
    WHERE gpx_file_id = ?
  `).bind(findCount, dataThrough, detectedFormat, ts, gpxFileId));

  // Deactivate previous file
  if (previousActive) {
    statements.push(env.DB.prepare(`
      UPDATE gpx_files SET is_active = 0, deleted_at = ?, deleted_by_user_id = ?
      WHERE gpx_file_id = ?
    `).bind(ts, user.userId, previousActive.gpx_file_id));

    statements.push(env.DB.prepare(`
      INSERT INTO gpx_file_events (event_id, gpx_file_id, event_type, executed_by_user_id, related_gpx_file_id, note, occurred_at)
      VALUES (?, ?, 'replaced', ?, ?, ?, ?)
    `).bind(uuid(), previousActive.gpx_file_id, user.userId, gpxFileId,
        `Superseded by ${fileRow.r2_key}`, ts));
  }

  // Audit events
  statements.push(env.DB.prepare(`
    INSERT INTO gpx_file_events (event_id, gpx_file_id, event_type, executed_by_user_id, note, occurred_at)
    VALUES (?, ?, 'uploaded', ?, ?, ?)
  `).bind(uuid(), gpxFileId, user.userId,
      `${findCount ?? '?'} finds, format: ${detectedFormat}`, ts));

  statements.push(env.DB.prepare(`
    INSERT INTO gpx_file_events (event_id, gpx_file_id, event_type, executed_by_user_id, note, occurred_at)
    VALUES (?, ?, 'parsed', ?, ?, ?)
  `).bind(uuid(), gpxFileId, user.userId,
      `${findCount ?? '?'} finds · data through ${dataThrough ?? 'unknown'} (browser-extracted)`, ts));

  // Update finder freshness (lifetime role only)
  if (fileRow.file_role === 'lifetime') {
    if (gcUsername) {
      statements.push(env.DB.prepare(`
        UPDATE finders SET lifetime_uploaded_at = ?, lifetime_find_count = ?,
          lifetime_data_through = ?, gc_username = ?, updated_at = ?
        WHERE finder_id = ?
      `).bind(ts, findCount, dataThrough, gcUsername, ts, fileRow.owner_finder_id));
    } else {
      statements.push(env.DB.prepare(`
        UPDATE finders SET lifetime_uploaded_at = ?, lifetime_find_count = ?,
          lifetime_data_through = ?, updated_at = ?
        WHERE finder_id = ?
      `).bind(ts, findCount, dataThrough, ts, fileRow.owner_finder_id));
    }
  }

  // Trip authorization
  if (body.trip_id) {
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO gpx_file_trip_auth (gpx_file_id, trip_id, authorized_by_user_id, authorized_at)
      VALUES (?, ?, ?, ?)
    `).bind(gpxFileId, body.trip_id, user.userId, ts));

    statements.push(env.DB.prepare(`
      INSERT INTO gpx_file_events (event_id, gpx_file_id, event_type, executed_by_user_id, related_trip_id, note, occurred_at)
      VALUES (?, ?, 'auth_granted', ?, ?, ?, ?)
    `).bind(uuid(), gpxFileId, user.userId, body.trip_id, `Authorized for trip ${body.trip_id}`, ts));
  }

  try {
    await env.DB.batch(statements);
  } catch (e) {
    return jsonError(`Database error during confirm: ${(e as Error).message}`, 500);
  }

  // Write county lifetime data if provided and this is a lifetime file
  const counties = body.counties ?? [];
  if (counties.length > 0 && fileRow.file_role === 'lifetime') {
    try {
      // Batch upsert — D1 batch limit is 100 statements
      const BATCH_SIZE = 100;
      const ts2 = now();
      for (let i = 0; i < counties.length; i += BATCH_SIZE) {
        const batch = counties.slice(i, i + BATCH_SIZE);
        const countyStatements = batch.map(c =>
          env.DB.prepare(`
            INSERT INTO finder_county_lifetime (finder_id, county_key, state, county, country, first_found)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (finder_id, county_key) DO UPDATE SET
              first_found = CASE WHEN excluded.first_found < first_found THEN excluded.first_found ELSE first_found END
          `).bind(
            fileRow.owner_finder_id,
            `${c.county}|${c.state}`,
            c.state,
            c.county,
            c.country ?? 'United States',
            Math.floor(new Date(c.firstFound + 'T00:00:00Z').getTime() / 1000),
          )
        );
        await env.DB.batch(countyStatements);
      }
    } catch (e) {
      // Non-fatal — log but don't fail the confirm
      console.error(`County upsert failed: ${(e as Error).message}`);
    }
  }

  // Write find-level data if provided and this is a lifetime file
  const finds = body.finds ?? [];
  if (finds.length > 0 && fileRow.file_role === 'lifetime') {
    try {
      // Use deterministic find_id based on (finder_id, gc_code, find_date)
      // so re-uploads produce the same ID and ON CONFLICT correctly deduplicates.
      // Format: ff_{finderId_hash}_{gcCode}_{findDate}
      function deterministicFindId(finderId: string, gcCode: string, findDate: string): string {
        // Simple stable hash — not cryptographic, just for dedup
        const raw = `${finderId}|${gcCode}|${findDate}`;
        let h = 0;
        for (let i = 0; i < raw.length; i++) {
          h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
        }
        const hex = Math.abs(h).toString(16).padStart(8, '0');
        return `ff_${hex}_${gcCode}_${findDate}`;
      }

      const BATCH_SIZE = 50;
      for (let i = 0; i < finds.length; i += BATCH_SIZE) {
        const batch = finds.slice(i, i + BATCH_SIZE);
        const findStatements = batch.map(f =>
          env.DB.prepare(`
            INSERT INTO finder_finds (
              find_id, finder_id, gc_code, cache_name, cache_owner,
              find_date, county, state, country, cache_type,
              difficulty, terrain, fav_points, lat, lon, placement_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (finder_id, gc_code, find_date) DO UPDATE SET
              cache_name     = excluded.cache_name,
              cache_owner    = excluded.cache_owner,
              county         = excluded.county,
              state          = excluded.state,
              country        = excluded.country,
              cache_type     = excluded.cache_type,
              difficulty     = excluded.difficulty,
              terrain        = excluded.terrain,
              fav_points     = excluded.fav_points,
              lat            = excluded.lat,
              lon            = excluded.lon,
              placement_date = excluded.placement_date
          `).bind(
            deterministicFindId(fileRow.owner_finder_id, f.gc_code, f.find_date),
            fileRow.owner_finder_id,
            f.gc_code,
            f.cache_name ?? null,
            f.cache_owner ?? null,
            f.find_date,
            f.county ?? null,
            f.state ?? null,
            f.country ?? null,
            f.cache_type ?? null,
            f.difficulty ?? null,
            f.terrain ?? null,
            f.fav_points ?? 0,
            f.lat ?? null,
            f.lon ?? null,
            f.placement_date ?? null,
          )
        );
        await env.DB.batch(findStatements);
      }

      // ── Upsert cache metadata to normalized caches table ──────────────────
      // Detect whether this upload has county info (PGC vs PQ)
      const hasCountyInfo = finds.some(f => f.county && f.state);
      const uploadSource: 'pgc' | 'pq' = hasCountyInfo ? 'pgc' : 'pq';
      // Source priority ranking: plan > pgc > pq > geocoded > null
      // Only overwrite existing metadata when new source ranks equal or better.
      const sourceRank: Record<string, number> = { plan: 4, pgc: 3, geocoded: 2, pq: 1 };

      for (let i = 0; i < finds.length; i += BATCH_SIZE) {
        const batch = finds.slice(i, i + BATCH_SIZE);
        const cacheStatements = batch.map(f => {
          const newRank = sourceRank[uploadSource] ?? 0;
          if (uploadSource === 'pgc' && f.county && f.state) {
            // PGC has county info — insert or update with pgc source
            return env.DB.prepare(`
              INSERT INTO caches (
                gc_code, name, cache_type, difficulty, terrain, lat, lon,
                county, state, country, county_source,
                placement_date, cache_owner, fav_points, status,
                first_seen, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pgc', ?, ?, ?, 'active', ?, ?)
              ON CONFLICT (gc_code) DO UPDATE SET
                name = COALESCE(excluded.name, name),
                cache_type = COALESCE(excluded.cache_type, cache_type),
                difficulty = COALESCE(excluded.difficulty, difficulty),
                terrain = COALESCE(excluded.terrain, terrain),
                lat = COALESCE(excluded.lat, lat),
                lon = COALESCE(excluded.lon, lon),
                county = excluded.county,
                state  = excluded.state,
                country = COALESCE(excluded.country, country),
                county_source = 'pgc',
                placement_date = COALESCE(excluded.placement_date, placement_date),
                cache_owner = COALESCE(excluded.cache_owner, cache_owner),
                fav_points = MAX(COALESCE(excluded.fav_points, 0), fav_points),
                updated_at = excluded.updated_at
              WHERE ? >= COALESCE(
                (SELECT CASE county_source
                  WHEN 'plan' THEN 4 WHEN 'pgc' THEN 3
                  WHEN 'geocoded' THEN 2 WHEN 'pq' THEN 1 ELSE 0 END
                 FROM caches WHERE gc_code = excluded.gc_code), 0)
            `).bind(
              f.gc_code, f.cache_name ?? null, f.cache_type ?? null,
              f.difficulty ?? null, f.terrain ?? null, f.lat ?? null, f.lon ?? null,
              f.county, f.state, f.country ?? null,
              f.placement_date ?? null, f.cache_owner ?? null, f.fav_points ?? 0,
              ts, ts,
              newRank
            );
          } else {
            // PQ upload — no county info; insert basic cache row if missing but
            // do NOT overwrite existing county/state/county_source
            return env.DB.prepare(`
              INSERT INTO caches (
                gc_code, name, cache_type, difficulty, terrain, lat, lon,
                country, placement_date, cache_owner, fav_points, status,
                first_seen, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
              ON CONFLICT (gc_code) DO UPDATE SET
                name = COALESCE(name, excluded.name),
                cache_type = COALESCE(cache_type, excluded.cache_type),
                difficulty = COALESCE(difficulty, excluded.difficulty),
                terrain = COALESCE(terrain, excluded.terrain),
                lat = COALESCE(lat, excluded.lat),
                lon = COALESCE(lon, excluded.lon),
                country = COALESCE(country, excluded.country),
                placement_date = COALESCE(placement_date, excluded.placement_date),
                cache_owner = COALESCE(cache_owner, excluded.cache_owner),
                fav_points = MAX(COALESCE(excluded.fav_points, 0), fav_points),
                updated_at = excluded.updated_at
            `).bind(
              f.gc_code, f.cache_name ?? null, f.cache_type ?? null,
              f.difficulty ?? null, f.terrain ?? null, f.lat ?? null, f.lon ?? null,
              f.country ?? null, f.placement_date ?? null, f.cache_owner ?? null,
              f.fav_points ?? 0, ts, ts
            );
          }
        });
        await env.DB.batch(cacheStatements);
      }
      console.log(`Cache upserts: ${finds.length} rows, source=${uploadSource}`);

      // Invalidate any trip reports that use this finder's data
      // so dashboard shows "Outdated" badge
      await env.DB.prepare(`
        UPDATE trips SET report_invalidated_at = ?
        WHERE trip_id IN (
          SELECT trip_id FROM trip_finders WHERE finder_id = ?
        )
      `).bind(ts, fileRow.owner_finder_id).run();

    } catch (e) {
      console.error(`Finds upsert failed: ${(e as Error).message}`);
    }
  }

  return jsonResponse({
    gpx_file_id: gpxFileId,
    find_count: findCount,
    data_through: dataThrough,
    format: detectedFormat,
    superseded_file_id: previousActive?.gpx_file_id ?? null,
  });
}



// ============================================================================
// GET /api/upload/status/:job_id
// ============================================================================

/**
 * Poll job status. Returns the job row from D1.
 * Frontend polls this after confirm returns 202 until status is
 * 'complete' or 'failed'.
 */
export async function handleJobStatus(
  jobId: string,
  user: import('./auth.js').AuthUser,
  env: UploadEnv & { DB: import('./types.js').D1Database },
): Promise<Response> {
  const job = await env.DB
    .prepare(`
      SELECT job_id, module, job_type, status, result_json,
             attempt_count, error, created_at, updated_at, completed_at
      FROM jobs
      WHERE job_id = ? AND user_id = ?
    `)
    .bind(jobId, user.userId)
    .first<{
      job_id: string;
      module: string;
      job_type: string;
      status: string;
      result_json: string | null;
      attempt_count: number;
      error: string | null;
      created_at: number;
      updated_at: number;
      completed_at: number | null;
    }>();

  if (!job) return jsonResponse({ error: 'Job not found' }, 404);

  return jsonResponse({
    job_id: job.job_id,
    module: job.module,
    job_type: job.job_type,
    status: job.status,
    result: job.result_json ? JSON.parse(job.result_json) : null,
    attempt_count: job.attempt_count,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  });
}
