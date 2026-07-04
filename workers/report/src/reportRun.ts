/**
 * reportRun.ts — Enqueue a report pipeline job for async processing.
 *
 * POST /api/report/run-from-r2
 *   Validates the request, creates a job row in D1, enqueues to the
 *   routesmith-jobs queue, and returns 202 with a job_id.
 *
 * GET /api/report/result/:job_id
 *   Returns the pipeline result JSON from R2 once the job completes.
 *   Returns 202 if still processing, 500 if failed.
 */

import type { AuthUser } from './auth.js';
import type { Env } from './types.js';
import type { JobMessage, ReportRunPayload } from './types.js';

// ============================================================================
// Request type
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
// POST /api/report/run-from-r2
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

  // Validate all GPX file IDs are accessible to this user
  for (const gpxFileId of body.owner.gpx_file_ids) {
    const row = await env.DB
      .prepare(`SELECT gf.gpx_file_id FROM gpx_files gf JOIN finders f ON f.finder_id = gf.owner_finder_id WHERE gf.gpx_file_id = ? AND f.owner_user_id = ? AND gf.is_active = 1 AND gf.deleted_at IS NULL`)
      .bind(gpxFileId, user.userId)
      .first<{ gpx_file_id: string }>();
    if (!row) return jsonError(`GPX file not found or not accessible: ${gpxFileId}`, 404);
  }

  for (const comp of body.companions ?? []) {
    for (const gpxFileId of comp.gpx_file_ids) {
      const row = await env.DB
        .prepare(`SELECT gf.gpx_file_id FROM gpx_files gf JOIN finders f ON f.finder_id = gf.owner_finder_id WHERE gf.gpx_file_id = ? AND f.owner_user_id = ? AND gf.is_active = 1 AND gf.deleted_at IS NULL`)
        .bind(gpxFileId, user.userId)
        .first<{ gpx_file_id: string }>();
      if (!row) return jsonError(`Companion GPX file not found or not accessible: ${gpxFileId}`, 404);
    }
  }

  const ts = Math.floor(Date.now() / 1000);
  const jobId = crypto.randomUUID();
  const resultR2Key = `report-results/${user.userId}/${jobId}.json`;

  const jobPayload: ReportRunPayload = {
    trip_name: body.trip.trip_name,
    start_date: body.trip.start_date,
    end_date: body.trip.end_date,
    distance_miles: body.trip.distance_miles,
    user_notes: body.trip.user_notes,
    enabled_rules: body.trip.enabled_rules,
    owner: body.owner,
    companions: body.companions,
    result_r2_key: resultR2Key,
  };

  // Create job row
  await env.DB.prepare(`
    INSERT INTO jobs (job_id, module, job_type, status, user_id, payload_json, created_at, updated_at)
    VALUES (?, 'report', 'report_run', 'pending', ?, ?, ?, ?)
  `).bind(jobId, user.userId, JSON.stringify(jobPayload), ts, ts).run();

  // Enqueue
  const message: JobMessage = {
    job_id: jobId,
    job_type: 'report_run',
    module: 'report',
    user_id: user.userId,
    payload: jobPayload as unknown as Record<string, unknown>,
  };

  try {
    await env.JOBS_QUEUE.send(message);
  } catch (e) {
    await env.DB.prepare(`UPDATE jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE job_id = ?`)
      .bind(`Queue send failed: ${(e as Error).message}`, ts, ts, jobId).run();
    return jsonError(`Failed to queue report job: ${(e as Error).message}`, 500);
  }

  return new Response(JSON.stringify({
    job_id: jobId,
    status: 'processing',
    message: 'Report pipeline queued. Poll /api/report/status/:job_id for progress.',
  }), { status: 202, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================================
// GET /api/report/status/:job_id
// ============================================================================

export async function handleReportStatus(
  jobId: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const job = await env.DB
    .prepare(`SELECT job_id, status, result_json, error, updated_at FROM jobs WHERE job_id = ? AND user_id = ?`)
    .bind(jobId, user.userId)
    .first<{ job_id: string; status: string; result_json: string | null; error: string | null; updated_at: number }>();

  if (!job) return jsonError('Job not found', 404);

  if (job.status === 'pending' || job.status === 'processing') {
    return new Response(JSON.stringify({ job_id: jobId, status: job.status }), {
      status: 202, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (job.status === 'failed') {
    return jsonError(`Report pipeline failed: ${job.error ?? 'Unknown error'}`, 500);
  }

  // Complete — fetch result from R2
  const jobResult = job.result_json ? JSON.parse(job.result_json) as { result_r2_key: string } : null;
  if (!jobResult?.result_r2_key) return jsonError('Result not found', 404);

  const obj = await env.REPORT_BUCKET.get(jobResult.result_r2_key);
  if (!obj) return jsonError('Result file not found in storage', 404);

  const resultJson = await obj.text();
  return new Response(resultJson, { headers: { 'Content-Type': 'application/json' } });
}

// ============================================================================
// Helper
// ============================================================================

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
