/**
 * types.ts — Core domain types for the Routesmith REPORT module.
 *
 * Mirrors the Python dataclass hierarchy from gpx_parser.py, statistics.py,
 * and rules.py. All dates are represented as Date objects (UTC midnight) or
 * ISO date strings at the API boundary.
 */

// ============================================================================
// Waypoint
// ============================================================================

export interface Waypoint {
  gcCode: string;
  name: string;
  cacheType: string | null;
  lat: number;
  lon: number;

  // Cache metadata
  container: string | null;
  difficulty: number | null;
  terrain: number | null;
  country: string | null;
  state: string | null;
  county: string | null;

  // Dates (UTC midnight, tz-naive equivalent)
  placementTime: Date | null;
  findDate: Date | null;

  favoritePoints: number;
  cacheOwner: string | null;
  attributes: Set<number>;
  finderLogText: string | null;
  sym: string | null;
  archived: boolean;
}

/** "County, ST" label for map display. */
export function stateCounty(w: Waypoint): string | null {
  if (!w.county || !w.state) return w.county;
  const abbrev = STATE_ABBREVIATIONS[w.state] ?? w.state;
  return `${w.county}, ${abbrev}`;
}

// ============================================================================
// Statistics
// ============================================================================

export interface AggregateStats {
  findsCount: number;
  favoritePointsEarned: number;
  distinctCounties: number;
  newCounties: number;
  distinctStates: number;
  newStates: number;
  newCountries: number;
  byCacheType: Record<string, number>;
  newCacheTypesFound: string[];
}

export interface DailyStats {
  dayDate: Date;
  finds: number;
  favoritePoints: number;
  counties: Set<string>; // "county|state" keys
  newCounties: number;
  byCacheType: Record<string, number>;
  bestFind: Waypoint | null;
  bestFindReason: string;
}

export interface PlayerStats {
  playerId: string;
  displayName: string;
  role: 'owner' | 'companion';
  aggregate: AggregateStats;
  byDay: DailyStats[];
}

// ============================================================================
// Rules
// ============================================================================

export type RuleSeverity = 'marquee' | 'featured' | 'note';
export type RuleType = 'categorical' | 'enumerated' | 'computed';

export interface Rule {
  id: string;
  displayName: string;
  description: string;
  severity: RuleSeverity;
  defaultEnabled: boolean;
  ruleType: RuleType;
  /** For categorical/computed rules. Return null for no match, string note for match. */
  test?: (wpt: Waypoint, ctx: RuleContext) => string | null;
  /** For enumerated rules. */
  codeSet?: Set<string>;
}

export interface RuleMatch {
  waypoint: Waypoint;
  note: string;
}

export interface RuleResult {
  rule: Rule;
  matches: RuleMatch[];
}

// Context passed to rule test functions. Keyed dynamically for milestone /
// jasmer / dt / state_completion hits which are pre-computed in the pipeline.
export type RuleContext = Record<string, unknown> & {
  priorCounties: Set<string>; // "county|state" keys
  priorStates: Set<string>;
  priorCountries: Set<string>;
  priorTypes: Set<string>;
};

// ============================================================================
// Trip input (matches trip-input.json schema)
// ============================================================================

export interface PlayerInput {
  playerId: string;
  displayName: string;
  gcUsername: string;
  /** Preferred: lifetime My Finds GPX paths / R2 keys */
  lifetimeGpxPaths?: string[];
  /** Fallback diff mode */
  beforeGpxPaths?: string[];
  afterGpxPaths?: string[];
}

export interface TripInput {
  version: number;
  tripName: string;
  startDate: string; // ISO date "YYYY-MM-DD"
  endDate: string;
  owner: PlayerInput;
  companions?: PlayerInput[];
  enabledRules?: string[];
  distance?: {
    miles?: number;
    hours?: number;
    gasCost?: number;
  };
  userNotes?: string;
}

// ============================================================================
// Counties data (passed to renderer)
// ============================================================================

export interface CountiesData {
  firstTime: Set<string>;      // "county|state" keys
  previouslyFound: Set<string>;
  missedOpportunity: Set<string>;
  stateCoverage: Record<string, { foundCount: number; total: number | null }>;
}

// ============================================================================
// Field availability flags
// ============================================================================

export interface FieldAvailability {
  hasCounty: boolean;
  hasFp: boolean;
}

// ============================================================================
// State reference data
// ============================================================================

export const STATE_ABBREVIATIONS: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR',
  California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID',
  Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS',
  Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE',
  Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
  'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
  'District of Columbia': 'DC',
};

export const STATE_COUNTY_TOTALS: Record<string, number> = {
  Alabama: 67, Alaska: 30, Arizona: 15, Arkansas: 75, California: 58,
  Colorado: 64, Connecticut: 8, Delaware: 3, 'District of Columbia': 1,
  Florida: 67, Georgia: 159, Hawaii: 5, Idaho: 44, Illinois: 102,
  Indiana: 92, Iowa: 99, Kansas: 105, Kentucky: 120, Louisiana: 64,
  Maine: 16, Maryland: 24, Massachusetts: 14, Michigan: 83,
  Minnesota: 87, Mississippi: 82, Missouri: 115, Montana: 56,
  Nebraska: 93, Nevada: 17, 'New Hampshire': 10, 'New Jersey': 21,
  'New Mexico': 33, 'New York': 62, 'North Carolina': 100,
  'North Dakota': 53, Ohio: 88, Oklahoma: 77, Oregon: 36,
  Pennsylvania: 67, 'Rhode Island': 5, 'South Carolina': 46,
  'South Dakota': 66, Tennessee: 95, Texas: 254, Utah: 29,
  Vermont: 14, Virginia: 133, Washington: 39, 'West Virginia': 55,
  Wisconsin: 72, Wyoming: 23,
};

/** Canonical county key. Stable across the whole codebase. */
export function countyKey(county: string, state: string): string {
  return `${county}|${state}`;
}

// ============================================================================
// Cloudflare runtime types
// Defined once here; imported by worker.ts, account.ts, upload.ts, etc.
// ============================================================================

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

/** Shared Worker environment bindings — see Queue section below for full definition. */

// ============================================================================
// Queue types
// ============================================================================

export interface Queue<T> {
  send(message: T): Promise<void>;
}

export type JobType = 'gpx_parse' | 'report_run';
export type JobModule = 'report' | 'plan' | 'navigate';

export interface JobMessage {
  job_id: string;
  job_type: JobType;
  module: JobModule;
  user_id: string;
  payload: Record<string, unknown>;
}

export interface ReportRunPayload {
  trip_name: string;
  start_date: string;
  end_date: string;
  distance_miles?: number;
  user_notes?: string;
  enabled_rules?: string[];
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
  result_r2_key: string;
}

// Extend Env with queue binding
export interface Env {
  REPORT_BUCKET: R2Bucket;
  DB: D1Database;
  CLERK_SECRET_KEY: string;
  JOBS_QUEUE: Queue<JobMessage>;
}
