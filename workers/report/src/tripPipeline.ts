/**
 * tripPipeline.ts — Trip pipeline endpoints (report Worker).
 *
 * POST /api/report/trip/:id/run
 *   Validates the trip, enqueues a trip_run job, returns job_id.
 *
 * GET /api/report/trip/:id/status/:job_id
 *   Returns job status and result once complete.
 *
 * GET /api/report/trip/:id/result
 *   Returns the most recent cached result from R2.
 *
 * All compute runs in the jobs Worker queue consumer.
 */

import type { AuthUser } from './auth.js';
import type { Env, JobMessage } from './types.js';

function uuid(): string { return crypto.randomUUID(); }
function now(): number  { return Math.floor(Date.now() / 1000); }

function jsonError(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================================
// POST /api/report/trip/:id/run
// ============================================================================

export async function handleTripRun(
  tripId: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  // Validate trip exists and belongs to user
  const trip = await env.DB
    .prepare(`SELECT trip_id, name, date_start, date_end FROM trips WHERE trip_id = ? AND user_id = ?`)
    .bind(tripId, user.userId)
    .first<{ trip_id: string; name: string; date_start: string | null; date_end: string | null }>();

  if (!trip) return jsonError('Trip not found', 404);
  if (!trip.date_start || !trip.date_end) return jsonError('Trip must have start and end dates set');

  // Validate owner has find data
  const ownerFinder = await env.DB
    .prepare(`SELECT tf.finder_id FROM trip_finders tf WHERE tf.trip_id = ? AND tf.role = 'owner'`)
    .bind(tripId)
    .first<{ finder_id: string }>();

  if (!ownerFinder) return jsonError('Trip owner finder not found');

  const countCheck = await env.DB
    .prepare(`SELECT COUNT(*) as cnt FROM finder_finds WHERE finder_id = ?`)
    .bind(ownerFinder.finder_id)
    .first<{ cnt: number }>();

  if (!countCheck?.cnt) {
    return jsonError('No find data in database. Re-upload your My Finds GPX on the account page to populate find-level data.');
  }

  const ts = now();
  const jobId = uuid();
  const resultR2Key = `report-results/${user.userId}/${tripId}/latest.json`;

  const jobPayload = {
    trip_id: tripId,
    user_id: user.userId,
    result_r2_key: resultR2Key,
  };

  // Create job row
  await env.DB.prepare(`
    INSERT INTO jobs (job_id, module, job_type, status, user_id, payload_json, created_at, updated_at)
    VALUES (?, 'report', 'trip_run', 'pending', ?, ?, ?, ?)
  `).bind(jobId, user.userId, JSON.stringify(jobPayload), ts, ts).run();

  // Enqueue
  const message: JobMessage = {
    job_id: jobId,
    job_type: 'trip_run',
    module: 'report',
    user_id: user.userId,
    payload: jobPayload,
  };

  try {
    await env.JOBS_QUEUE.send(message);
  } catch (e) {
    await env.DB.prepare(`UPDATE jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE job_id = ?`)
      .bind(`Queue send failed: ${(e as Error).message}`, ts, ts, jobId).run();
    return jsonError(`Failed to queue trip run job: ${(e as Error).message}`, 500);
  }

  return new Response(JSON.stringify({
    job_id: jobId,
    status: 'pending',
    message: 'Trip pipeline queued. Poll /api/report/trip/:id/status/:job_id for progress.',
  }), { status: 202, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================================
// GET /api/report/trip/:id/status/:job_id
// ============================================================================

export async function handleTripStatus(
  tripId: string,
  jobId: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const job = await env.DB
    .prepare(`SELECT job_id, status, result_json, error FROM jobs WHERE job_id = ? AND user_id = ?`)
    .bind(jobId, user.userId)
    .first<{ job_id: string; status: string; result_json: string | null; error: string | null }>();

  if (!job) return jsonError('Job not found', 404);

  if (job.status === 'pending' || job.status === 'processing') {
    return new Response(JSON.stringify({ job_id: jobId, status: job.status }), {
      status: 202, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (job.status === 'failed') {
    return jsonError(`Pipeline failed: ${job.error ?? 'Unknown error'}`, 500);
  }

  // Complete — return the result from R2
  const jobResult = job.result_json ? JSON.parse(job.result_json) as { result_r2_key: string } : null;
  if (!jobResult?.result_r2_key) return jsonError('Result not found', 404);

  const obj = await env.REPORT_BUCKET.get(jobResult.result_r2_key);
  if (!obj) return jsonError('Result file not found in storage', 404);

  return new Response(await obj.text(), { headers: { 'Content-Type': 'application/json' } });
}

// ============================================================================
// GET /api/report/trip/:id/result
// ============================================================================

export async function handleTripResult(
  tripId: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const trip = await env.DB
    .prepare(`SELECT trip_id FROM trips WHERE trip_id = ? AND user_id = ?`)
    .bind(tripId, user.userId).first();
  if (!trip) return jsonError('Trip not found', 404);

  const report = await env.DB
    .prepare(`SELECT output_r2_key FROM trip_reports WHERE trip_id = ? ORDER BY generated_at DESC LIMIT 1`)
    .bind(tripId)
    .first<{ output_r2_key: string }>();

  if (!report) return jsonError('No report generated yet', 404);

  const obj = await env.REPORT_BUCKET.get(report.output_r2_key);
  if (!obj) return jsonError('Report result not found in storage', 404);

  return new Response(await obj.text(), { headers: { 'Content-Type': 'application/json' } });
}
