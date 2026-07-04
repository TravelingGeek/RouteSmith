/**
 * worker.ts — Routesmith async job consumer Worker.
 *
 * Consumes messages from the 'routesmith-jobs' Cloudflare Queue.
 * Dispatches to job-type-specific handlers.
 *
 * Queue consumer Workers have no incoming HTTP requests — they only
 * implement the queue() handler. The fetch() handler is a health check
 * for wrangler dev convenience.
 *
 * Retry behavior:
 *   - Handler throws  → Cloudflare retries (up to max_retries in wrangler.toml)
 *   - Handler returns → message acknowledged, not retried
 *   Non-retryable errors are caught inside handlers, job marked failed,
 *   then re-thrown with a marker so the consumer can ack the message
 *   without further retries. See gpxParseJob.ts for the pattern.
 */

import type { Env, JobMessage } from './types.js';
import { handleGpxParseJob } from './gpxParseJob.js';
import { handleReportRunJob } from './reportRunJob.js';

export default {
  // ── Queue consumer ──────────────────────────────────────────────────────────
  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      const attemptNumber = (message.attempts ?? 1);

      console.log(`[${job.job_type}] job_id=${job.job_id} attempt=${attemptNumber}`);

      try {
        switch (job.job_type) {
          case 'gpx_parse':
            await handleGpxParseJob(
              job.job_id,
              job.user_id,
              job.payload as import('./types.js').GpxParsePayload,
              attemptNumber,
              env,
            );
            break;

          case 'report_run':
            await handleReportRunJob(
              job.job_id,
              job.user_id,
              job.payload as unknown as import('./types.js').ReportRunPayload,
              attemptNumber,
              env,
            );
            break;

          default:
            // Unknown job type — ack without processing (don't retry)
            console.error(`Unknown job_type: ${job.job_type} — acknowledging without processing`);
            await markUnknownJobFailed(env, job, attemptNumber);
        }

        // Acknowledge successful message
        message.ack();
        console.log(`[${job.job_type}] job_id=${job.job_id} complete`);

      } catch (e) {
        const msg = (e as Error).message ?? String(e);

        // Non-retryable: handler marked job failed and re-threw with marker
        if (msg.includes('not retrying')) {
          console.error(`[${job.job_type}] job_id=${job.job_id} failed (non-retryable): ${msg}`);
          message.ack(); // ack so Cloudflare doesn't retry
          return;
        }

        // Retryable: let Cloudflare retry by not acking
        console.error(`[${job.job_type}] job_id=${job.job_id} error (will retry): ${msg}`);
        message.retry();
      }
    }
  },

  // ── Health check (dev only) ─────────────────────────────────────────────────
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response(JSON.stringify({ status: 'ok', worker: 'routesmith-jobs' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

// ============================================================================
// Helpers
// ============================================================================

async function markUnknownJobFailed(
  env: Env,
  job: JobMessage,
  attempt: number,
): Promise<void> {
  const ts = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`
      UPDATE jobs
      SET status = 'failed', error = ?, attempt_count = ?,
          updated_at = ?, completed_at = ?
      WHERE job_id = ?
    `)
    .bind(`Unknown job_type: ${job.job_type}`, attempt, ts, ts, job.job_id)
    .run();
  } catch {
    // Best-effort — don't let a D1 error prevent the ack
  }
}

// Cloudflare Workers Queue types
interface MessageBatch<T> {
  readonly queue: string;
  readonly messages: Message<T>[];
}

interface Message<T> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(): void;
}
