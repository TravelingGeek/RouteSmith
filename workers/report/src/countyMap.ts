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
