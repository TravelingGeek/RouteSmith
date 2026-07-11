/**
 * countyMap.ts — County data builder for the dashboard map.
 * Extracted from pipeline.ts for reuse in tripPipeline.ts.
 */

import type { Waypoint, CountiesData } from './types.js';
import { countyKey, STATE_COUNTY_TOTALS, STATE_ABBREVIATIONS } from './types.js';

export function buildCountiesData(
  tripFinds: Waypoint[],
  priorCounties: Set<string>,
): CountiesData {
  const firstTime       = new Set<string>();
  const previouslyFound = new Set<string>();
  const byStateCounties = new Map<string, Set<string>>();

  const toAbbrev = (state: string): string => {
    if (state.length === 2) return state.toUpperCase();
    return (STATE_ABBREVIATIONS as Record<string, string>)[state] ?? state;
  };

  // Normalize prior counties to use abbreviation
  const normalizedPrior = new Set<string>();
  for (const key of priorCounties) {
    const [county, state] = key.split('|');
    normalizedPrior.add(`${county}|${toAbbrev(state)}`);
    if (!byStateCounties.has(state)) byStateCounties.set(state, new Set());
    byStateCounties.get(state)!.add(county);
  }

  for (const wpt of tripFinds) {
    if (!wpt.county || !wpt.state) continue;
    const key = `${wpt.county}|${toAbbrev(wpt.state)}`;
    if (normalizedPrior.has(key)) {
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
    missedOpportunity: new Set(),
    stateCoverage,
  };
}

/**
 * Build per-finder county attribution — for each county key, list of finder IDs
 * who found caches there during the trip window. Used for county map pins.
 */
export interface PerFinderCountyAttribution {
  countyAttribution: Record<string, { finderIds: string[]; findCounts: Record<string, number>; finderStatus: Record<string, 'new' | 'prev'> }>;
}

export function buildPerFinderCountyAttribution(
  perFinderTripFinds: Record<string, Array<{ gc_code: string; county: string | null; state: string | null; find_date: string }>>,
  perFinderPriorCounties?: Record<string, Set<string>>,
): PerFinderCountyAttribution {
  const countyAttribution: Record<string, { finderIds: string[]; findCounts: Record<string, number>; finderStatus: Record<string, 'new' | 'prev'> }> = {};

  // Normalize a state name to its abbreviation for map lookup consistency.
  // If already an abbreviation (2 chars), keep it; otherwise look it up.
  const toAbbrev = (state: string): string => {
    if (state.length === 2) return state.toUpperCase();
    return (STATE_ABBREVIATIONS as Record<string, string>)[state] ?? state;
  };

  // Build normalized prior sets — key is county|ABBREV
  const normalizedPrior: Record<string, Set<string>> = {};
  if (perFinderPriorCounties) {
    for (const [fid, priorSet] of Object.entries(perFinderPriorCounties)) {
      const norm = new Set<string>();
      for (const key of priorSet) {
        const [county, state] = key.split('|');
        norm.add(`${county}|${toAbbrev(state)}`);
      }
      normalizedPrior[fid] = norm;
    }
  }

  for (const [finderId, finds] of Object.entries(perFinderTripFinds)) {
    const priorSet = normalizedPrior[finderId] ?? new Set<string>();
    for (const f of finds) {
      if (!f.county || !f.state) continue;
      const key = `${f.county}|${toAbbrev(f.state)}`;
      if (!countyAttribution[key]) {
        countyAttribution[key] = { finderIds: [], findCounts: {}, finderStatus: {} };
      }
      if (!countyAttribution[key].finderIds.includes(finderId)) {
        countyAttribution[key].finderIds.push(finderId);
        countyAttribution[key].finderStatus[finderId] = priorSet.has(key) ? 'prev' : 'new';
      }
      countyAttribution[key].findCounts[finderId] = (countyAttribution[key].findCounts[finderId] ?? 0) + 1;
    }
  }

  return { countyAttribution };
}
