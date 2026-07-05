export interface Env {
  DB: D1Database;
  DATA_BUCKET: R2Bucket;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1Result {
  success: boolean;
  meta?: Record<string, unknown>;
  results?: unknown[];
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

export interface R2Bucket {
  put(key: string, value: ArrayBuffer | ReadableStream | string, options?: R2PutOptions): Promise<R2Object>;
  get(key: string): Promise<R2ObjectBody | null>;
  list(options?: R2ListOptions): Promise<R2Objects>;
  delete(key: string): Promise<void>;
}

export interface R2Object {
  key: string;
  size: number;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
}

export interface R2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}


