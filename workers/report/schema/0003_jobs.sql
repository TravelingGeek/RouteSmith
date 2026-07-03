-- =============================================================================
-- Routesmith D1 Schema — Migration 0003
-- Async job queue tracking table
-- =============================================================================

-- -----------------------------------------------------------------------------
-- jobs
-- One row per async job. Written by the API Worker when a job is enqueued,
-- updated by the Consumer Worker as the job progresses.
--
-- module: which Routesmith module owns this job ('report' | 'plan' | 'navigate')
--   Informational in v1; used for UX filtering in future (e.g. show only
--   PLAN jobs on the PLAN dashboard).
--
-- job_type: the specific operation to perform.
--   v1 types: 'gpx_parse'
--   Future:   'route_optimize', 'monitor_check', 'report_generate'
--
-- status:
--   'pending'    — enqueued, not yet picked up by consumer
--   'processing' — consumer has started work
--   'complete'   — finished successfully
--   'failed'     — exhausted retries or caught a non-retryable error
--
-- attempt_count: incremented by the consumer on each attempt.
--   Cloudflare Queues handles retry scheduling; this is for observability.
--
-- payload_json: job-specific input data (JSON string).
--   For gpx_parse: { gpx_file_id, finder_id, r2_key, file_role, scope }
--
-- result_json: job-specific output data (JSON string). NULL until complete.
--   For gpx_parse: { find_count, data_through, format, superseded_file_id }
--
-- error: last error message if status is 'failed'. NULL otherwise.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
    job_id          TEXT PRIMARY KEY,   -- UUID
    module          TEXT NOT NULL,      -- report | plan | navigate
    job_type        TEXT NOT NULL,      -- gpx_parse | route_optimize | ...
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | processing | complete | failed
    user_id         TEXT NOT NULL REFERENCES users (user_id),
    payload_json    TEXT NOT NULL,
    result_json     TEXT,
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      INTEGER NOT NULL,   -- Unix epoch seconds
    updated_at      INTEGER NOT NULL,
    completed_at    INTEGER             -- NULL until complete or failed
);

CREATE INDEX IF NOT EXISTS idx_jobs_user    ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs (status, job_type);
CREATE INDEX IF NOT EXISTS idx_jobs_module  ON jobs (module, status);
CREATE INDEX IF NOT EXISTS idx_jobs_type    ON jobs (job_type, status);
