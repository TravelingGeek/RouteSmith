/**
 * countyMap.ts — County data builder for the dashboard map.
 * Extracted from pipeline.ts for reuse in tripPipeline.ts.
 */

import type { Waypoint, CountiesData } from './types.js';
import { countyKey, STATE_COUNTY_TOTALS } from './types.js';

export function buildCountiesData(
  tripFinds: Waypoint[],
  priorCounties: Set<string>,
): CountiesData {
  const firstTime       = new Set<string>();
  const previouslyFound = new Set<string>();
  const byStateCounties = new Map<string, Set<string>>();

  for (const key of priorCounties) {
    const [county, state] = key.split('|');
    if (!byStateCounties.has(state)) byStateCounties.set(state, new Set());
    byStateCounties.get(state)!.add(county);
  }

  for (const wpt of tripFinds) {
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

  for (const [finderId, finds] of Object.entries(perFinderTripFinds)) {
    const priorSet = perFinderPriorCounties?.[finderId] ?? new Set<string>();
    for (const f of finds) {
      if (!f.county || !f.state) continue;
      const key = countyKey(f.county, f.state);
      if (!countyAttribution[key]) {
        countyAttribution[key] = { finderIds: [], findCounts: {}, finderStatus: {} };
      }
      if (!countyAttribution[key].finderIds.includes(finderId)) {
        countyAttribution[key].finderIds.push(finderId);
        // Determine per-finder status: 'new' if not in this finder's prior counties, else 'prev'
        countyAttribution[key].finderStatus[finderId] = priorSet.has(key) ? 'prev' : 'new';
      }
      countyAttribution[key].findCounts[finderId] = (countyAttribution[key].findCounts[finderId] ?? 0) + 1;
    }
  }

  return { countyAttribution };
}
