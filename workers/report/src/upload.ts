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
  if (file_size_bytes > 50 * 1024 * 1024) return jsonError('File too large (max 50MB)');

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
    gc_username?: string; // optional: update finder's gc_username on confirm
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
  const jobId = uuid();

  // Write trip authorization if trip_id supplied
  const authStatements: D1PreparedStatement[] = [];
  if (body.trip_id) {
    authStatements.push(
      env.DB.prepare(`
        INSERT OR IGNORE INTO gpx_file_trip_auth (
          gpx_file_id, trip_id, authorized_by_user_id, authorized_at
        ) VALUES (?, ?, ?, ?)
      `).bind(gpxFileId, body.trip_id, user.userId, ts)
    );
    authStatements.push(
      env.DB.prepare(`
        INSERT INTO gpx_file_events (
          event_id, gpx_file_id, event_type, executed_by_user_id,
          related_trip_id, note, occurred_at
        ) VALUES (?, ?, 'auth_granted', ?, ?, ?, ?)
      `).bind(uuid(), gpxFileId, user.userId, body.trip_id, `Authorized for trip ${body.trip_id}`, ts)
    );
    await env.DB.batch(authStatements);
  }

  // Update gc_username if supplied
  if (body.gc_username) {
    await env.DB.prepare(`
      UPDATE finders SET gc_username = ?, updated_at = ?
      WHERE finder_id = ?
    `).bind(body.gc_username, ts, fileRow.owner_finder_id).run();
  }

  // Create job row
  const jobPayload = {
    gpx_file_id: gpxFileId,
    finder_id: fileRow.owner_finder_id,
    r2_key: fileRow.r2_key,
    file_role: fileRow.file_role,
    scope: fileRow.scope,
  };

  await env.DB.prepare(`
    INSERT INTO jobs (
      job_id, module, job_type, status, user_id,
      payload_json, created_at, updated_at
    ) VALUES (?, 'report', 'gpx_parse', 'pending', ?, ?, ?, ?)
  `).bind(jobId, user.userId, JSON.stringify(jobPayload), ts, ts).run();

  // Enqueue the parse job
  const jobMessage: JobMessage = {
    job_id: jobId,
    job_type: 'gpx_parse',
    module: 'report',
    user_id: user.userId,
    payload: jobPayload,
  };

  try {
    await env.JOBS_QUEUE.send(jobMessage);
  } catch (e) {
    // If queue send fails, mark job as failed so user can retry
    await env.DB.prepare(`
      UPDATE jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
      WHERE job_id = ?
    `).bind(`Queue send failed: ${(e as Error).message}`, ts, ts, jobId).run();
    return jsonError(`Failed to queue parse job: ${(e as Error).message}`, 500);
  }

  return jsonResponse({
    gpx_file_id: gpxFileId,
    job_id: jobId,
    status: 'processing',
    message: 'File uploaded. Parse job queued — poll /api/upload/status/:job_id for results.',
  }, 202);
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
