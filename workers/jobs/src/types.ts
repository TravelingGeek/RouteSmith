/**
 * types.ts — Shared Cloudflare runtime types for the routesmith-jobs Worker.
 */

export interface R2ObjectBody {
  key: string;
  size: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<{ key: string; size: number }>;
  delete(key: string): Promise<void>;
}

export interface D1Result {
  success: boolean;
  meta: { changes: number };
}

export interface D1PreparedStatement {
  bind(...args: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface Env {
  REPORT_BUCKET: R2Bucket;
  DB: D1Database;
}

// ============================================================================
// Job message schema
// ============================================================================

export type JobType = 'gpx_parse';
export type JobModule = 'report' | 'plan' | 'navigate';
export type JobStatus = 'pending' | 'processing' | 'complete' | 'failed';

export interface JobMessage {
  job_id: string;
  job_type: JobType;
  module: JobModule;
  user_id: string;
  payload: GpxParsePayload; // union as more job types are added
}

export interface GpxParsePayload {
  gpx_file_id: string;
  finder_id: string;
  r2_key: string;
  file_role: string;
  scope: string;
}

export interface GpxParseResult {
  find_count: number;
  data_through: string | null;
  format: string;
  superseded_file_id: string | null;
}
