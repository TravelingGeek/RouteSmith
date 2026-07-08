/**
 * statistics.ts — Aggregate, per-day, milestone, Jasmer, and D/T statistics.
 *
 * Pure functions — no I/O. All date comparisons use UTC day boundaries
 * (matching the tz-naive convention in the Python reference implementation).
 *
 * Python reference: statistics.py
 */

import type { Waypoint, AggregateStats, DailyStats, PlayerStats } from './types.js';
import { countyKey, STATE_COUNTY_TOTALS } from './types.js';

// ============================================================================
// Date helpers
// ============================================================================

/** Return the UTC date string "YYYY-MM-DD" from a Date object. */
function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Compare two Dates by UTC day only. */
function utcDayOf(d: Date): string {
  return utcDateStr(d);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function utcDaysBetween(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  let cur = new Date(start);
  while (utcDayStr(cur) <= utcDayStr(end)) {
    days.push(new Date(cur));
    cur = addDays(cur, 1);
  }
  return days;
}

function utcDayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function inRange(findDate: Date, start: Date, end: Date): boolean {
  const s = utcDayStr(findDate);
  return s >= utcDayStr(start) && s <= utcDayStr(end);
}

// ============================================================================
// Prior data computation
// ============================================================================

/**
 * Compute the finder's prior territory from all lifetime finds before tripStart.
 * Returns sets of county keys, state names, country names, and cache types.
 *
 * Python reference: compute_prior_data
 */
export function computePriorData(allFinds: Waypoint[], tripStart: Date): {
  priorCounties: Set<string>;
  priorStates: Set<string>;
  priorCountries: Set<string>;
  priorTypes: Set<string>;
} {
  const priorCounties = new Set<string>();
  const priorStates = new Set<string>();
  const priorCountries = new Set<string>();
  const priorTypes = new Set<string>();

  const startStr = utcDayStr(tripStart);

  for (const w of allFinds) {
    if (!w.findDate) continue;
    if (utcDayStr(w.findDate) >= startStr) continue;
    if (w.county && w.state) priorCounties.add(countyKey(w.county, w.state));
    if (w.state) priorStates.add(w.state);
    if (w.country) priorCountries.add(w.country);
    if (w.cacheType) priorTypes.add(w.cacheType);
  }

  return { priorCounties, priorStates, priorCountries, priorTypes };
}

// ============================================================================
// Aggregate stats
// ============================================================================

/**
 * Compute trip-level aggregate stats for one player.
 * Python reference: compute_aggregate_stats
 */
export function computeAggregateStats(
  tripFinds: Waypoint[],
  priorCounties: Set<string>,
  priorStates: Set<string>,
  priorCountries: Set<string>,
  priorTypes: Set<string>,
): AggregateStats {
  const countiesInTrip = new Set<string>();
  const statesInTrip = new Set<string>();
  const countriesInTrip = new Set<string>();
  const typesCount: Record<string, number> = {};
  const newTypesFound: string[] = [];
  let fp = 0;

  for (const w of tripFinds) {
    fp += w.favoritePoints ?? 0;
    if (w.county && w.state) countiesInTrip.add(countyKey(w.county, w.state));
    if (w.state) statesInTrip.add(w.state);
    if (w.country) countriesInTrip.add(w.country);
    if (w.cacheType) {
      typesCount[w.cacheType] = (typesCount[w.cacheType] ?? 0) + 1;
      if (!priorTypes.has(w.cacheType) && !newTypesFound.includes(w.cacheType)) {
        newTypesFound.push(w.cacheType);
      }
    }
  }

  return {
    findsCount: tripFinds.length,
    favoritePointsEarned: fp,
    distinctCounties: countiesInTrip.size,
    newCounties: [...countiesInTrip].filter(k => !priorCounties.has(k)).length,
    distinctStates: statesInTrip.size,
    newStates: [...statesInTrip].filter(s => !priorStates.has(s)).length,
    newCountries: [...countriesInTrip].filter(c => !priorCountries.has(c)).length,
    byCacheType: typesCount,
    newCacheTypesFound: newTypesFound,
  };
}

// ============================================================================
// Daily stats
// ============================================================================

/**
 * Compute per-day stats for one player across the trip window.
 * Every date in [tripStart, tripEnd] gets an entry, even zero-find days.
 * Python reference: compute_daily_stats
 */
export function computeDailyStats(
  tripFinds: Waypoint[],
  priorCounties: Set<string>,
  tripStart: Date,
  tripEnd: Date,
): DailyStats[] {
  // Bucket by date
  const byDate = new Map<string, Waypoint[]>();
  for (const w of tripFinds) {
    if (!w.findDate) continue;
    const d = utcDayStr(w.findDate);
    if (d < utcDayStr(tripStart) || d > utcDayStr(tripEnd)) continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(w);
  }

  const days = utcDaysBetween(tripStart, tripEnd);
  const countiesSeen = new Set(priorCounties);
  const result: DailyStats[] = [];

  for (const dayDate of days) {
    const d = utcDayStr(dayDate);
    const dayFinds = (byDate.get(d) ?? []).sort((a, b) =>
      (b.favoritePoints ?? 0) - (a.favoritePoints ?? 0)
    );

    const ds: DailyStats = {
      dayDate,
      finds: dayFinds.length,
      favoritePoints: 0,
      counties: new Set<string>(),
      newCounties: 0,
      byCacheType: {},
      bestFind: dayFinds[0] ?? null,
      bestFindReason: '',
    };

    for (const w of dayFinds) {
      ds.favoritePoints += w.favoritePoints ?? 0;
      if (w.county && w.state) {
        const key = countyKey(w.county, w.state);
        ds.counties.add(key);
        if (!countiesSeen.has(key)) {
          ds.newCounties++;
          countiesSeen.add(key);
        }
      }
      if (w.cacheType) {
        ds.byCacheType[w.cacheType] = (ds.byCacheType[w.cacheType] ?? 0) + 1;
      }
    }

    if (ds.bestFind) {
      ds.bestFindReason = (ds.bestFind.favoritePoints ?? 0) >= 50
        ? `Highest favorited that day (${ds.bestFind.favoritePoints} FP)`
        : 'Most notable find that day';
    }

    result.push(ds);
  }

  return result;
}

// ============================================================================
// Milestone finds
// ============================================================================

const MILESTONE_NUMBERS = new Set([
  500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000,
  8000, 9000, 10000, 15000, 20000, 25000, 30000, 40000, 50000,
]);

/**
 * Identify trip finds that hit a round-number milestone.
 * Returns a map of gcCode → milestone number.
 * Python reference: compute_milestones
 */
export function computeMilestones(
  allFinds: Waypoint[],
  tripStart: Date,
  tripEnd: Date,
): Map<string, number> {
  const sorted = allFinds
    .filter(w => w.findDate)
    .sort((a, b) => a.findDate!.getTime() - b.findDate!.getTime());

  const result = new Map<string, number>();
  const startStr = utcDayStr(tripStart);
  const endStr = utcDayStr(tripEnd);

  sorted.forEach((w, i) => {
    const n = i + 1;
    if (MILESTONE_NUMBERS.has(n)) {
      const d = utcDayStr(w.findDate!);
      if (d >= startStr && d <= endStr) {
        result.set(w.gcCode, n);
      }
    }
  });

  return result;
}

// ============================================================================
// Jasmer grid fills
// ============================================================================

/**
 * Find trip finds that filled a previously-empty Jasmer cell (year × month placed).
 * Returns a map of gcCode → label string (e.g. "May 2000").
 * Python reference: compute_jasmer_fills
 */
export function computeJasmerFills(
  allFinds: Waypoint[],
  tripStart: Date,
  tripEnd: Date,
): Map<string, string> {
  const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const startStr = utcDayStr(tripStart);
  const endStr = utcDayStr(tripEnd);

  const cellsFilledBefore = new Set<string>();
  const tripFinds: Waypoint[] = [];

  for (const w of allFinds) {
    if (!w.findDate || !w.placementTime) continue;
    const cell = `${w.placementTime.getUTCFullYear()}|${w.placementTime.getUTCMonth() + 1}`;
    const d = utcDayStr(w.findDate);
    if (d < startStr) {
      cellsFilledBefore.add(cell);
    } else if (d <= endStr) {
      tripFinds.push(w);
    }
  }

  const cellsFilledDuring = new Set<string>();
  const result = new Map<string, string>();
  const sorted = tripFinds.sort((a, b) => a.findDate!.getTime() - b.findDate!.getTime());

  for (const w of sorted) {
    const y = w.placementTime!.getUTCFullYear();
    const m = w.placementTime!.getUTCMonth() + 1;
    const cell = `${y}|${m}`;
    if (!cellsFilledBefore.has(cell) && !cellsFilledDuring.has(cell)) {
      cellsFilledDuring.add(cell);
      result.set(w.gcCode, `${MONTHS[m]} ${y}`);
    }
  }

  return result;
}

// ============================================================================
// D/T grid fills
// ============================================================================

/**
 * Find trip finds that filled a previously-empty D/T grid cell.
 * Returns a map of gcCode → [difficulty, terrain] tuple.
 * Python reference: compute_dt_fills
 */
export function computeDtFills(
  allFinds: Waypoint[],
  tripStart: Date,
  tripEnd: Date,
): Map<string, [number, number]> {
  const startStr = utcDayStr(tripStart);
  const endStr = utcDayStr(tripEnd);

  const cellsFilledBefore = new Set<string>();
  const tripFinds: Waypoint[] = [];

  for (const w of allFinds) {
    if (!w.findDate || w.difficulty === null || w.terrain === null) continue;
    const cell = `${w.difficulty}|${w.terrain}`;
    const d = utcDayStr(w.findDate);
    if (d < startStr) {
      cellsFilledBefore.add(cell);
    } else if (d <= endStr) {
      tripFinds.push(w);
    }
  }

  const cellsFilledDuring = new Set<string>();
  const result = new Map<string, [number, number]>();
  const sorted = tripFinds.sort((a, b) => a.findDate!.getTime() - b.findDate!.getTime());

  for (const w of sorted) {
    const cell = `${w.difficulty}|${w.terrain}`;
    if (!cellsFilledBefore.has(cell) && !cellsFilledDuring.has(cell)) {
      cellsFilledDuring.add(cell);
      result.set(w.gcCode, [w.difficulty!, w.terrain!]);
    }
  }

  return result;
}

// ============================================================================
// Jasmer grid state (for visualization)
// ============================================================================

export type JasmerCellState = 'filled_before' | 'filled_during' | 'empty';

/**
 * Compute the complete Jasmer grid state for visualization.
 * Returns a map of "year|month" → state.
 * Python reference: compute_jasmer_grid_state
 */
export function computeJasmerGridState(
  allFinds: Waypoint[],
  tripStart: Date,
  tripEnd: Date,
  yearMax?: number,
): Map<string, JasmerCellState> {
  const maxYear = yearMax ?? new Date().getUTCFullYear();
  const startStr = utcDayStr(tripStart);
  const endStr = utcDayStr(tripEnd);

  // Track the first fill date for each cell
  const firstFill = new Map<string, string>(); // cell → ISO date string

  for (const w of allFinds) {
    if (!w.findDate || !w.placementTime) continue;
    const cell = `${w.placementTime.getUTCFullYear()}|${w.placementTime.getUTCMonth() + 1}`;
    const d = utcDayStr(w.findDate);
    const existing = firstFill.get(cell);
    if (!existing || d < existing) firstFill.set(cell, d);
  }

  const state = new Map<string, JasmerCellState>();

  for (let year = 2000; year <= maxYear; year++) {
    for (let month = 1; month <= 12; month++) {
      if (year === 2000 && month < 5) continue; // No caches placed before May 2000
      const cell = `${year}|${month}`;
      const fd = firstFill.get(cell);
      if (!fd) {
        state.set(cell, 'empty');
      } else if (fd < startStr) {
        state.set(cell, 'filled_before');
      } else if (fd <= endStr) {
        state.set(cell, 'filled_during');
      } else {
        state.set(cell, 'empty'); // Filled after trip — treat as empty for this report
      }
    }
  }

  return state;
}

// ============================================================================
// State completion detection
// ============================================================================

/**
 * Identify US states that reached 100% county coverage during the trip.
 * Returns a map of gcCode → { state, total }.
 * Python reference: _compute_state_completions (generate.py)
 */
export function computeStateCompletions(
  ownerTripFinds: Waypoint[],
  ownerPriorCounties: Set<string>,
): Map<string, { state: string; total: number }> {
  // Group trip finds by state (US only, with county data)
  const byState = new Map<string, Waypoint[]>();
  for (const w of ownerTripFinds) {
    if (!w.state || !w.county || !w.findDate) continue;
    if (!(w.state in STATE_COUNTY_TOTALS)) continue;
    if (!byState.has(w.state)) byState.set(w.state, []);
    byState.get(w.state)!.push(w);
  }

  const result = new Map<string, { state: string; total: number }>();

  for (const [state, finds] of byState) {
    const total = STATE_COUNTY_TOTALS[state];
    const priorInState = new Set(
      [...ownerPriorCounties]
        .filter(k => k.endsWith(`|${state}`))
        .map(k => k.split('|')[0])
    );
    if (priorInState.size >= total) continue; // Already complete before trip

    const sorted = [...finds].sort((a, b) => a.findDate!.getTime() - b.findDate!.getTime());
    const running = new Set(priorInState);

    for (const w of sorted) {
      running.add(w.county!);
      if (running.size >= total) {
        result.set(w.gcCode, { state, total });
        break;
      }
    }
  }

  return result;
}

// ============================================================================
// Trip window filter
// ============================================================================

/** Return only finds whose findDate falls within [start, end] (inclusive, UTC day). */
export function filterToTripWindow(
  finds: Waypoint[],
  start: Date,
  end: Date,
): Waypoint[] {
  const s = utcDayStr(start);
  const e = utcDayStr(end);
  return finds.filter(w => {
    if (!w.findDate) return false;
    const d = utcDayStr(w.findDate);
    return d >= s && d <= e;
  });
}

// ============================================================================
// Companion trip finds (lifetime or diff mode)
// ============================================================================

export type CompanionMode = 'lifetime' | 'diff' | 'none';

/**
 * Compute a companion's trip finds from their data.
 * Returns { tripFinds, priorFinds, mode }.
 * Python reference: _compute_companion_trip_finds (generate.py)
 */
export function computeCompanionTripFinds(
  allFinds: Waypoint[], // Already parsed lifetime or before/after
  tripStart: Date,
  tripEnd: Date,
  mode: CompanionMode,
): { tripFinds: Waypoint[]; priorFinds: Waypoint[] } {
  if (mode === 'lifetime') {
    const s = utcDayStr(tripStart);
    const e = utcDayStr(tripEnd);
    const tripFinds: Waypoint[] = [];
    const priorFinds: Waypoint[] = [];
    for (const w of allFinds) {
      if (!w.findDate) continue;
      const d = utcDayStr(w.findDate);
      if (d >= s && d <= e) tripFinds.push(w);
      else if (d < s) priorFinds.push(w);
    }
    return { tripFinds, priorFinds };
  }

  if (mode === 'diff') {
    // allFinds is assumed to be the "after" set; caller passes before codes separately
    // This case is handled at the pipeline layer (see pipeline.ts)
    return { tripFinds: allFinds, priorFinds: [] };
  }

  return { tripFinds: [], priorFinds: [] };
}

// ============================================================================
// Empty-window diagnostic
// ============================================================================

/**
 * Return a diagnostic string when the trip window produced 0 finds.
 * Mirrors Python's _diagnose_empty_trip_window.
 */
export function diagnoseEmptyTripWindow(
  allFinds: Waypoint[],
  tripStart: Date,
  tripEnd: Date,
  expectedUsername: string,
): string {
  const withDates = allFinds.filter(w => w.findDate !== null);
  const s = utcDayStr(tripStart);
  const e = utcDayStr(tripEnd);

  if (withDates.length === 0) {
    return (
      `DIAGNOSTIC: 0 finds matched the trip window.\n` +
      `Total waypoints parsed: ${allFinds.length}\n` +
      `No waypoints have a findDate set. Possible causes:\n` +
      `  - gc_username '${expectedUsername}' doesn't match log entries\n` +
      `  - GPX is a generic Pocket Query, not a My Finds export\n`
    );
  }

  const dates = withDates.map(w => utcDayStr(w.findDate!)).sort();
  const nearWindow = dates.filter(d => d >= subDays(s, 30) && d <= addDaysStr(e, 30));
  return (
    `DIAGNOSTIC: 0 finds in window ${s} to ${e}.\n` +
    `Find-date range observed: ${dates[0]} to ${dates[dates.length - 1]}\n` +
    (nearWindow.length
      ? `Finds within 30 days of window: ${nearWindow.length}`
      : `No finds within 30 days of trip window. Check the trip dates.`)
  );
}

function subDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return utcDayStr(d);
}
function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return utcDayStr(d);
}

// ============================================================================
// Loop-aware grid state (Jasmer and D/T)
// ============================================================================

/**
 * Loop state for a grid: which loop is being worked on, cell counts, trip additions.
 * Cell keys use the same format as the query returns:
 *   - Jasmer: "YYYY-MM" (matches SUBSTR of placement_date)
 *   - D/T:    "D|T" (e.g. "3.5|4.0")
 */
export interface LoopState {
  loopNumber: number;               // 1 = working on first fill of every cell, 2 = second, etc.
  totalCells: number;               // Total possible cells (Jasmer varies by year, DT = 81)
  completedCellsInLoop: number;     // Cells that have been filled at least loopNumber times prior to trip
  completedCells: number;           // Alias for above (dashboard uses this name)
  cellCounts: Record<string, number>;      // cell key → total lifetime finds in that cell (as of trip end)
  newFillsThisTrip: Map<string, string>;   // gcCode → cell key (finds that filled a cell for the FIRST time in this loop)
  tripAdditionsPerCell: Record<string, number>; // cell key → count of trip finds in that cell
}

interface JasmerCountRow  { month: string;      priorCount: number; }
interface JasmerTripRow   { gcCode: string; month: string;      findDate: string; }
interface DtCountRow      { difficulty: number; terrain: number; priorCount: number; }
interface DtTripRow       { gcCode: string; difficulty: number; terrain: number; findDate: string; }

/**
 * Return the total number of Jasmer cells possible as of a given month.
 * Grid starts May 2000 (first geocache). Each subsequent month adds a cell.
 */
function jasmerTotalCells(asOfMonth: string): number {
  const [y, m] = asOfMonth.split('-').map(Number);
  // Months from May 2000 (2000-05) through asOfMonth inclusive
  return (y - 2000) * 12 + m - 4;
}

export function computeJasmerLoopState(
  priorCounts: JasmerCountRow[],
  tripRows: JasmerTripRow[],
): LoopState {
  // Total cells possible = months from May 2000 through current month
  const now = new Date();
  const nowMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const totalCells = jasmerTotalCells(nowMonth);

  // Build cellCounts from prior data (as of trip start)
  const cellCounts: Record<string, number> = {};
  for (const r of priorCounts) cellCounts[r.month] = r.priorCount;

  // Determine current loop number = minimum priorCount across all cells that have at least one find
  // Loop N means: every cell has been filled at least N times. If any cell has 0 prior, we're on loop 1.
  // For simplicity: loop = min(priorCount) + 1 across all possible cells
  let loopNumber = 1;
  let minCount = 0;
  const allCells: string[] = [];
  for (let y = 2000; y <= now.getUTCFullYear(); y++) {
    const startM = y === 2000 ? 5 : 1;
    const endM   = y === now.getUTCFullYear() ? now.getUTCMonth() + 1 : 12;
    for (let m = startM; m <= endM; m++) {
      allCells.push(`${y}-${String(m).padStart(2, '0')}`);
    }
  }

  // Find the minimum count across all possible cells (missing = 0)
  minCount = Infinity;
  for (const cell of allCells) {
    const c = cellCounts[cell] ?? 0;
    if (c < minCount) minCount = c;
  }
  loopNumber = minCount + 1;

  // Count how many cells are "complete" for the current loop
  // "Complete" means they have >= loopNumber finds already
  let completedCells = 0;
  for (const cell of allCells) {
    const c = cellCounts[cell] ?? 0;
    if (c >= loopNumber) completedCells++;
  }

  // Process trip finds — track which finds newly completed the current loop's cell
  const newFillsThisTrip = new Map<string, string>();
  const tripAdditionsPerCell: Record<string, number> = {};
  const sortedTrip = tripRows.slice().sort((a, b) => a.findDate.localeCompare(b.findDate));

  for (const r of sortedTrip) {
    const cur = cellCounts[r.month] ?? 0;
    // If this cell hasn't yet been filled for the current loop, this find fills it
    if (cur < loopNumber) {
      newFillsThisTrip.set(r.gcCode, r.month);
    }
    cellCounts[r.month] = cur + 1;
    tripAdditionsPerCell[r.month] = (tripAdditionsPerCell[r.month] ?? 0) + 1;
  }

  return {
    loopNumber,
    totalCells,
    completedCellsInLoop: completedCells,
    completedCells,
    cellCounts,
    newFillsThisTrip,
    tripAdditionsPerCell,
  };
}

export function computeDtLoopState(
  priorCounts: DtCountRow[],
  tripRows: DtTripRow[],
): LoopState {
  const totalCells = 81; // 9 difficulty × 9 terrain values (1.0, 1.5, ..., 5.0)

  const cellCounts: Record<string, number> = {};
  for (const r of priorCounts) cellCounts[`${r.difficulty}|${r.terrain}`] = r.priorCount;

  // All 81 DT cells
  const allCells: string[] = [];
  for (let d = 1.0; d <= 5.0; d += 0.5) {
    for (let t = 1.0; t <= 5.0; t += 0.5) {
      // Normalize to fixed 1-decimal to avoid FP drift
      allCells.push(`${d.toFixed(1)}|${t.toFixed(1)}`);
    }
  }

  // Normalize cellCounts keys similarly
  const normalizedCounts: Record<string, number> = {};
  for (const [key, count] of Object.entries(cellCounts)) {
    const [d, t] = key.split('|').map(Number);
    normalizedCounts[`${d.toFixed(1)}|${t.toFixed(1)}`] = count;
  }

  let minCount = Infinity;
  for (const cell of allCells) {
    const c = normalizedCounts[cell] ?? 0;
    if (c < minCount) minCount = c;
  }
  const loopNumber = minCount + 1;

  let completedCells = 0;
  for (const cell of allCells) {
    if ((normalizedCounts[cell] ?? 0) >= loopNumber) completedCells++;
  }

  const newFillsThisTrip = new Map<string, string>();
  const tripAdditionsPerCell: Record<string, number> = {};
  const sortedTrip = tripRows.slice().sort((a, b) => a.findDate.localeCompare(b.findDate));

  for (const r of sortedTrip) {
    const key = `${r.difficulty.toFixed(1)}|${r.terrain.toFixed(1)}`;
    const cur = normalizedCounts[key] ?? 0;
    if (cur < loopNumber) {
      newFillsThisTrip.set(r.gcCode, key);
    }
    normalizedCounts[key] = cur + 1;
    tripAdditionsPerCell[key] = (tripAdditionsPerCell[key] ?? 0) + 1;
  }

  return {
    loopNumber,
    totalCells,
    completedCellsInLoop: completedCells,
    completedCells,
    cellCounts: normalizedCounts,
    newFillsThisTrip,
    tripAdditionsPerCell,
  };
}
