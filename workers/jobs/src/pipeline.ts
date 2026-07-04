/**
 * pipeline.ts — Main REPORT pipeline orchestrator.
 *
 * Ties together GPX parsing, statistics computation, rule evaluation,
 * and data assembly. The output of runPipeline() is a typed PipelineResult
 * object that the renderer consumes to produce HTML or dashboard data.
 *
 * This is the TypeScript equivalent of generate.py's main() function and
 * its supporting helpers. No I/O happens here — callers pass in already-
 * fetched GPX texts and reference list data, making the pipeline fully
 * testable in isolation.
 *
 * Python reference: generate.py
 */

import type {
  TripInput,
  PlayerInput,
  PlayerStats,
  AggregateStats,
  DailyStats,
  RuleContext,
  CountiesData,
  FieldAvailability,
} from './types.js';
import { countyKey, STATE_ABBREVIATIONS, STATE_COUNTY_TOTALS } from './types.js';
import type { Waypoint } from './types.js';
import { parseGpxTexts, checkGpxCompleteness } from './gpxParser.js';
import {
  computePriorData,
  computeAggregateStats,
  computeDailyStats,
  computeMilestones,
  computeJasmerFills,
  computeJasmerGridState,
  computeDtFills,
  computeStateCompletions,
  filterToTripWindow,
  diagnoseEmptyTripWindow,
  type JasmerCellState,
} from './statistics.js';
import { buildDefaultRules, evaluateAllRules } from './rules.js';
import type { RuleResult } from './types.js';
import { injectReferenceContext, type ReferenceLists } from './referenceLists.js';

// ============================================================================
// Pipeline inputs and outputs
// ============================================================================

/**
 * All GPX data pre-fetched by the caller. Keys match PlayerInput.playerId.
 * Each player has an array of GPX texts (lifetime, or before/after).
 */
export interface GpxSources {
  owner: {
    lifetime: string[]; // Array of GPX texts (base + incremental)
  };
  companions: Array<{
    playerId: string;
    lifetime?: string[];
    before?: string[];
    after?: string[];
  }>;
}

export interface PipelineResult {
  tripInput: TripInput;
  ownerStats: PlayerStats;
  allPlayerStats: PlayerStats[];
  ruleResults: RuleResult[];
  countiesData: CountiesData;
  jasmerGridState: Map<string, JasmerCellState>;
  fieldAvailability: FieldAvailability;
  warnings: string[];
  diagnostics: string[];
}

// ============================================================================
// Pipeline entry point
// ============================================================================

/**
 * Run the full REPORT pipeline.
 *
 * @param tripInput   Parsed trip-input.json (from D1 or request body).
 * @param gpxSources  Pre-fetched GPX texts for owner and companions.
 * @param refLists    Pre-loaded bookmark list reference data.
 */
export async function runPipeline(
  tripInput: TripInput,
  gpxSources: GpxSources,
  refLists: ReferenceLists,
): Promise<PipelineResult> {
  const warnings: string[] = [...refLists.warnings];
  const diagnostics: string[] = [];

  const tripStart = new Date(tripInput.startDate + 'T00:00:00Z');
  const tripEnd   = new Date(tripInput.endDate   + 'T00:00:00Z');

  // ── Owner GPX ────────────────────────────────────────────────────────────

  const ownerInput = tripInput.owner;
  const ownerLifetime = await parseGpxTexts(
    gpxSources.owner.lifetime,
    ownerInput.gcUsername,
  );

  const fieldAvailability = checkGpxCompleteness(ownerLifetime);
  warnings.push(...fieldAvailability.warnings);

  const ownerTripFinds = filterToTripWindow(ownerLifetime, tripStart, tripEnd);

  if (ownerTripFinds.length === 0 && ownerLifetime.length > 0) {
    diagnostics.push(
      diagnoseEmptyTripWindow(ownerLifetime, tripStart, tripEnd, ownerInput.gcUsername)
    );
  }

  // ── Owner stats ──────────────────────────────────────────────────────────

  const { priorCounties, priorStates, priorCountries, priorTypes } =
    computePriorData(ownerLifetime, tripStart);

  const ownerAggregate = computeAggregateStats(
    ownerTripFinds,
    priorCounties,
    priorStates,
    priorCountries,
    priorTypes,
  );

  const ownerDailyStats = computeDailyStats(
    ownerTripFinds,
    priorCounties,
    tripStart,
    tripEnd,
  );

  const milestones    = computeMilestones(ownerLifetime, tripStart, tripEnd);
  const jasmerFills   = computeJasmerFills(ownerLifetime, tripStart, tripEnd);
  const dtFills       = computeDtFills(ownerLifetime, tripStart, tripEnd);
  const stateComps    = computeStateCompletions(ownerTripFinds, priorCounties);
  const jasmerGrid    = computeJasmerGridState(ownerLifetime, tripStart, tripEnd);

  // ── Rule context ─────────────────────────────────────────────────────────

  const ctx: RuleContext = {
    priorCounties,
    priorStates,
    priorCountries,
    priorTypes,
  };

  // Inject per-cache computed flags
  for (const [gcCode, milestone] of milestones) {
    (ctx as Record<string, number>)[`milestone_for_${gcCode}`] = milestone;
  }
  for (const [gcCode, cell] of jasmerFills) {
    (ctx as Record<string, string>)[`jasmer_fill_${gcCode}`] = cell;
  }
  for (const [gcCode, cell] of dtFills) {
    (ctx as Record<string, [number, number]>)[`dt_fill_${gcCode}`] = cell;
  }
  for (const [gcCode, info] of stateComps) {
    (ctx as Record<string, { state: string; total: number }>)[`state_completion_${gcCode}`] = info;
  }

  // Inject state abbreviation lookup (used by testNewCounty)
  for (const [state, abbrev] of Object.entries(STATE_ABBREVIATIONS)) {
    (ctx as Record<string, string>)[`stateAbbrev_${state}`] = abbrev;
  }

  // Inject reference lists
  injectReferenceContext(ctx as Record<string, unknown>, refLists);

  // ── Owner PlayerStats ─────────────────────────────────────────────────────

  const ownerStats: PlayerStats = {
    playerId: ownerInput.playerId,
    displayName: ownerInput.displayName,
    role: 'owner',
    aggregate: ownerAggregate,
    byDay: ownerDailyStats,
  };

  // ── Rule evaluation ───────────────────────────────────────────────────────

  const rules = buildDefaultRules();
  const { results: ruleResults, warnings: ruleWarnings } = evaluateAllRules(
    ownerTripFinds,
    rules,
    ctx,
    tripInput.enabledRules,
  );
  warnings.push(...ruleWarnings);

  // ── Companion stats ───────────────────────────────────────────────────────

  const companionStats: PlayerStats[] = [];

  for (const compInput of tripInput.companions ?? []) {
    const compSource = gpxSources.companions.find(c => c.playerId === compInput.playerId);
    if (!compSource) continue;

    const compStats = await buildCompanionStats(
      compInput,
      compSource,
      tripStart,
      tripEnd,
    );
    if (compStats) companionStats.push(compStats);
  }

  // ── Counties data ─────────────────────────────────────────────────────────

  const countiesData = buildCountiesData(ownerTripFinds, priorCounties);

  // ── Result ────────────────────────────────────────────────────────────────

  return {
    tripInput,
    ownerStats,
    allPlayerStats: [ownerStats, ...companionStats],
    ruleResults,
    countiesData,
    jasmerGridState: jasmerGrid,
    fieldAvailability: {
      hasCounty: fieldAvailability.hasCounty,
      hasFp: fieldAvailability.hasFp,
    },
    warnings,
    diagnostics,
  };
}

// ============================================================================
// Companion stats builder
// ============================================================================

async function buildCompanionStats(
  input: PlayerInput,
  source: GpxSources['companions'][number],
  tripStart: Date,
  tripEnd: Date,
): Promise<PlayerStats | null> {
  let tripFinds: Waypoint[];
  let priorFinds: Waypoint[];
  let mode: 'lifetime' | 'diff' | 'none' = 'none';

  if (source.lifetime && source.lifetime.length > 0) {
    // Preferred: lifetime My Finds GPX
    mode = 'lifetime';
    const all = await parseGpxTexts(source.lifetime, input.gcUsername);
    const s = tripStart.toISOString().slice(0, 10);
    const e = tripEnd.toISOString().slice(0, 10);
    tripFinds = [];
    priorFinds = [];
    for (const w of all) {
      if (!w.findDate) continue;
      const d = w.findDate.toISOString().slice(0, 10);
      if (d >= s && d <= e) tripFinds.push(w);
      else if (d < s) priorFinds.push(w);
    }
  } else if (source.before || source.after) {
    // Fallback: before/after snapshot diff
    mode = 'diff';
    const before = source.before ? await parseGpxTexts(source.before, input.gcUsername) : [];
    const after  = source.after  ? await parseGpxTexts(source.after,  input.gcUsername) : [];
    const beforeCodes = new Set(before.map(w => w.gcCode));
    tripFinds = after.filter(w => !beforeCodes.has(w.gcCode));
    priorFinds = before;
  } else {
    return null;
  }

  const priorCounties  = new Set(priorFinds.filter(w => w.county && w.state).map(w => countyKey(w.county!, w.state!)));
  const priorStates    = new Set(priorFinds.filter(w => w.state).map(w => w.state!));
  const priorCountries = new Set(priorFinds.filter(w => w.country).map(w => w.country!));
  const priorTypes     = new Set(priorFinds.filter(w => w.cacheType).map(w => w.cacheType!));

  const aggregate = computeAggregateStats(
    tripFinds,
    priorCounties,
    priorStates,
    priorCountries,
    priorTypes,
  );

  // Per-day stats only available in lifetime mode (need per-find timestamps)
  const byDay: DailyStats[] = mode === 'lifetime' && tripFinds.length > 0
    ? computeDailyStats(tripFinds, priorCounties, tripStart, tripEnd)
    : [];

  return {
    playerId: input.playerId,
    displayName: input.displayName,
    role: 'companion',
    aggregate,
    byDay,
  };
}

// ============================================================================
// Counties data builder
// ============================================================================

function buildCountiesData(
  ownerTripFinds: Waypoint[],
  priorCounties: Set<string>,
): CountiesData {
  const firstTime    = new Set<string>();
  const previouslyFound = new Set<string>();
  const byStateCounties = new Map<string, Set<string>>();

  // Prior counties → populate by-state map
  for (const key of priorCounties) {
    const [county, state] = key.split('|');
    if (!byStateCounties.has(state)) byStateCounties.set(state, new Set());
    byStateCounties.get(state)!.add(county);
  }

  for (const wpt of ownerTripFinds) {
    if (!wpt.county || !wpt.state) continue;
    const key = countyKey(wpt.county, wpt.state);
    if (priorCounties.has(key)) {
      previouslyFound.add(key);
    } else {
      firstTime.add(key);
    }
    if (!byStateCounties.has(wpt.state)) byStateCounties.set(wpt.state, new Set());
    byStateCounties.get(wpt.state)!.add(wpt.county);
  }

  const stateCoverage: Record<string, { foundCount: number; total: number | null }> = {};
  for (const [state, counties] of byStateCounties) {
    stateCoverage[state] = {
      foundCount: counties.size,
      total: STATE_COUNTY_TOTALS[state] ?? null,
    };
  }

  return {
    firstTime,
    previouslyFound,
    missedOpportunity: new Set(), // Requires route data; v1+ via PLAN integration
    stateCoverage,
  };
}

// ============================================================================
// Pre-parsed pipeline entry point
// ============================================================================

export interface ParsedGpxSources {
  owner: {
    lifetime: import('./types.js').Waypoint[];
  };
  companions: Array<{
    playerId: string;
    lifetime?: import('./types.js').Waypoint[];
    before?: import('./types.js').Waypoint[];
    after?: import('./types.js').Waypoint[];
  }>;
}

/**
 * Run the pipeline with pre-parsed waypoints instead of raw GPX text.
 * Used by reportRun.ts to avoid holding both raw text and parsed waypoints
 * in memory simultaneously.
 */
export async function runPipelineFromWaypoints(
  tripInput: TripInput,
  parsed: ParsedGpxSources,
  refLists: ReferenceLists,
): Promise<PipelineResult> {
  const warnings: string[] = [...refLists.warnings];
  const diagnostics: string[] = [];

  const tripStart = new Date(tripInput.startDate + 'T00:00:00Z');
  const tripEnd   = new Date(tripInput.endDate   + 'T00:00:00Z');

  const ownerLifetime = parsed.owner.lifetime;

  const fieldAvailability = checkGpxCompleteness(ownerLifetime);
  warnings.push(...fieldAvailability.warnings);

  const ownerTripFinds = filterToTripWindow(ownerLifetime, tripStart, tripEnd);

  if (ownerTripFinds.length === 0 && ownerLifetime.length > 0) {
    diagnostics.push(diagnoseEmptyTripWindow(ownerLifetime, tripStart, tripEnd, tripInput.owner.gcUsername));
  }

  const { priorCounties, priorStates, priorCountries, priorTypes } =
    computePriorData(ownerLifetime, tripStart);

  const ownerAggregate = computeAggregateStats(ownerTripFinds, priorCounties, priorStates, priorCountries, priorTypes);
  const ownerDailyStats = computeDailyStats(ownerTripFinds, priorCounties, tripStart, tripEnd);
  const milestones    = computeMilestones(ownerLifetime, tripStart, tripEnd);
  const jasmerFills   = computeJasmerFills(ownerLifetime, tripStart, tripEnd);
  const dtFills       = computeDtFills(ownerLifetime, tripStart, tripEnd);
  const stateComps    = computeStateCompletions(ownerTripFinds, priorCounties);
  const jasmerGrid    = computeJasmerGridState(ownerLifetime, tripStart, tripEnd);

  const ctx: RuleContext = { priorCounties, priorStates, priorCountries, priorTypes };
  for (const [gc, milestone] of milestones) (ctx as Record<string, number>)[`milestone_for_${gc}`] = milestone;
  for (const [gc, cell] of jasmerFills)    (ctx as Record<string, string>)[`jasmer_fill_${gc}`] = cell;
  for (const [gc, cell] of dtFills)        (ctx as Record<string, [number,number]>)[`dt_fill_${gc}`] = cell;
  for (const [gc, info] of stateComps)     (ctx as Record<string, {state:string;total:number}>)[`state_completion_${gc}`] = info;
  for (const [state, abbrev] of Object.entries(STATE_ABBREVIATIONS)) (ctx as Record<string, string>)[`stateAbbrev_${state}`] = abbrev;
  injectReferenceContext(ctx as Record<string, unknown>, refLists);

  const ownerStats: PlayerStats = {
    playerId: tripInput.owner.playerId,
    displayName: tripInput.owner.displayName,
    role: 'owner',
    aggregate: ownerAggregate,
    byDay: ownerDailyStats,
  };

  const rules = buildDefaultRules();
  const { results: ruleResults, warnings: ruleWarnings } = evaluateAllRules(ownerTripFinds, rules, ctx, tripInput.enabledRules);
  warnings.push(...ruleWarnings);

  // Companion stats from pre-parsed waypoints
  const companionStats: PlayerStats[] = [];
  for (const compInput of tripInput.companions ?? []) {
    const compSource = parsed.companions.find(c => c.playerId === compInput.playerId);
    if (!compSource) continue;

    let tripFinds: Waypoint[];
    let priorFinds: Waypoint[];

    if (compSource.lifetime) {
      const s = tripStart.toISOString().slice(0, 10);
      const e = tripEnd.toISOString().slice(0, 10);
      tripFinds  = compSource.lifetime.filter(w => { if (!w.findDate) return false; const d = w.findDate.toISOString().slice(0,10); return d >= s && d <= e; });
      priorFinds = compSource.lifetime.filter(w => { if (!w.findDate) return false; return w.findDate.toISOString().slice(0,10) < s; });
    } else if (compSource.before !== undefined && compSource.after !== undefined) {
      const beforeCodes = new Set(compSource.before.map(w => w.gcCode));
      tripFinds  = compSource.after.filter(w => !beforeCodes.has(w.gcCode));
      priorFinds = compSource.before;
    } else {
      continue;
    }

    const compPriorCounties  = new Set(priorFinds.filter(w => w.county && w.state).map(w => countyKey(w.county!, w.state!)));
    const compPriorStates    = new Set(priorFinds.filter(w => w.state).map(w => w.state!));
    const compPriorCountries = new Set(priorFinds.filter(w => w.country).map(w => w.country!));
    const compPriorTypes     = new Set(priorFinds.filter(w => w.cacheType).map(w => w.cacheType!));

    const aggregate = computeAggregateStats(tripFinds, compPriorCounties, compPriorStates, compPriorCountries, compPriorTypes);
    const byDay = compSource.lifetime && tripFinds.length > 0
      ? computeDailyStats(tripFinds, compPriorCounties, tripStart, tripEnd)
      : [];

    companionStats.push({ playerId: compInput.playerId, displayName: compInput.displayName, role: 'companion', aggregate, byDay });
  }

  const countiesData = buildCountiesData(ownerTripFinds, priorCounties);

  return { tripInput, ownerStats, allPlayerStats: [ownerStats, ...companionStats], ruleResults, countiesData, jasmerGridState: jasmerGrid, fieldAvailability: { hasCounty: fieldAvailability.hasCounty, hasFp: fieldAvailability.hasFp }, warnings, diagnostics };
}
