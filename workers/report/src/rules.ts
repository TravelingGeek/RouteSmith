/**
 * rules.ts — Highlight rule definitions for the Routesmith REPORT module.
 *
 * Rule taxonomy:
 *   categorical — test is a function of cache properties already in the GPX
 *   enumerated  — test is set membership in a curated list of GC codes
 *   computed    — test requires multi-cache or external data (rule context)
 *
 * The RuleContext carries pre-computed per-cache flags set by the pipeline
 * (milestones, jasmer fills, D/T fills, state completions, bookmark lists).
 * Each flag is a property on the context object keyed by GC code, e.g.:
 *   ctx['milestone_for_GC12345'] = 1000
 *   ctx['jasmer_fill_GC12345']   = 'May 2000'
 *   ctx['dt_fill_GC12345']       = [2.5, 3.0]
 *   ctx['state_completion_GC12345'] = { state: 'Kansas', total: 105 }
 *
 * Python reference: rules.py
 */

import type { Rule, RuleMatch, RuleResult, RuleContext } from './types.js';
import type { Waypoint } from './types.js';

// ============================================================================
// Rare cache type set
// ============================================================================

const RARE_CACHE_TYPES = new Set([
  'Project APE Cache',
  'Mega-Event Cache',
  'Webcam Cache',
  'Giga-Event Cache',
  'GPS Adventures Maze Exhibit',
  'GPS Adventures Exhibit',
  'Geocaching HQ',
  'Headquarters',
  'Locationless (Reverse) Cache',
  'Groundspeak Block Party',
  'Block Party',
  'Groundspeak Lost and Found Celebration',
  'Lost and Found Celebration',
  'Lost and Found Event Cache',
  'Lost and Found Event Caches',
]);

// ============================================================================
// Categorical / computed test functions
// ============================================================================

function testPlacedYear(year: number) {
  return (wpt: Waypoint, _ctx: RuleContext): string | null => {
    if (wpt.placementTime?.getUTCFullYear() === year) {
      return `Placed in ${year} — early in geocaching's history.`;
    }
    return null;
  };
}

function testHighFav(threshold: number) {
  return (wpt: Waypoint, _ctx: RuleContext): string | null => {
    if (wpt.favoritePoints >= threshold) {
      return `${wpt.favoritePoints} favorite points — exceptionally popular.`;
    }
    return null;
  };
}

function testRareCacheType(wpt: Waypoint, _ctx: RuleContext): string | null {
  if (wpt.cacheType && RARE_CACHE_TYPES.has(wpt.cacheType)) {
    return `${wpt.cacheType} — rare cache type.`;
  }
  return null;
}

function testCacheType(typeName: string, description: string) {
  return (wpt: Waypoint, _ctx: RuleContext): string | null =>
    wpt.cacheType === typeName ? description : null;
}

function testNewCountry(wpt: Waypoint, ctx: RuleContext): string | null {
  const prior = ctx.priorCountries as Set<string>;
  if (wpt.country && !prior.has(wpt.country)) {
    return `First find ever in ${wpt.country}.`;
  }
  return null;
}

function testNewState(wpt: Waypoint, ctx: RuleContext): string | null {
  const prior = ctx.priorStates as Set<string>;
  if (wpt.state && !prior.has(wpt.state)) {
    return `First find ever in ${wpt.state}.`;
  }
  return null;
}

function testNewCounty(wpt: Waypoint, ctx: RuleContext): string | null {
  const prior = ctx.priorCounties as Set<string>;
  if (wpt.county && wpt.state) {
    const key = `${wpt.county}|${wpt.state}`;
    if (!prior.has(key)) {
      const abbrev = (ctx as Record<string, string>)[`stateAbbrev_${wpt.state}`] ?? wpt.state;
      return `First find ever in ${wpt.county}, ${abbrev}.`;
    }
  }
  return null;
}

function testNewCacheType(wpt: Waypoint, ctx: RuleContext): string | null {
  const prior = ctx.priorTypes as Set<string>;
  if (wpt.cacheType && !prior.has(wpt.cacheType)) {
    return `First ${wpt.cacheType} ever.`;
  }
  return null;
}

function testMilestoneFind(wpt: Waypoint, ctx: RuleContext): string | null {
  const milestone = (ctx as Record<string, number | undefined>)[`milestone_for_${wpt.gcCode}`];
  if (milestone) return `Find #${milestone} of all time.`;
  return null;
}

function testJasmerGridFill(wpt: Waypoint, ctx: RuleContext): string | null {
  const cell = (ctx as Record<string, string | undefined>)[`jasmer_fill_${wpt.gcCode}`];
  if (cell) return `Filled an empty Jasmer cell (${cell}).`;
  return null;
}

function testDtGridFill(wpt: Waypoint, ctx: RuleContext): string | null {
  const cell = (ctx as Record<string, [number, number] | undefined>)[`dt_fill_${wpt.gcCode}`];
  if (cell) return `Filled an empty D/T grid cell (D=${cell[0]}, T=${cell[1]}).`;
  return null;
}

function testOldestActivePerState(wpt: Waypoint, ctx: RuleContext): string | null {
  const map = ctx['oldestActivePerState'] as Map<string, string> | undefined;
  const state = map?.get(wpt.gcCode);
  if (state) return `Oldest active cache in ${state}.`;
  return null;
}

function testOldestActivePerCountry(wpt: Waypoint, ctx: RuleContext): string | null {
  const map = ctx['oldestActivePerCountry'] as Map<string, string> | undefined;
  const country = map?.get(wpt.gcCode);
  if (country) return `Oldest active cache in ${country}.`;
  return null;
}

function testCacheAcrossAmerica(wpt: Waypoint, ctx: RuleContext): string | null {
  const map = ctx['cacheAcrossAmerica'] as Map<string, { state?: string }> | undefined;
  const entry = map?.get(wpt.gcCode);
  if (entry) {
    const s = entry.state ?? wpt.state ?? '';
    return s ? `Cache Across America — ${s}.` : 'Cache Across America.';
  }
  return null;
}

function testCacheOdyssey(wpt: Waypoint, ctx: RuleContext): string | null {
  const set = ctx['cacheOdyssey'] as Set<string> | undefined;
  if (set?.has(wpt.gcCode)) return 'Cache Odyssey member.';
  return null;
}

function testStateCompletion(wpt: Waypoint, ctx: RuleContext): string | null {
  const info = (ctx as Record<string, { state: string; total: number } | undefined>)[
    `state_completion_${wpt.gcCode}`
  ];
  if (info) return `Completed ${info.state} — last of ${info.total} counties.`;
  return null;
}

function testMegaGigaEvent(wpt: Waypoint, _ctx: RuleContext): string | null {
  if (wpt.cacheType === 'Mega-Event Cache') return 'Mega-Event Cache — rare event type.';
  if (wpt.cacheType === 'Giga-Event Cache') return 'Giga-Event Cache — extremely rare event type.';
  return null;
}

// ============================================================================
// Rule registry
// ============================================================================

/**
 * Build the default rule registry.
 * Python reference: build_default_rules()
 */
export function buildDefaultRules(): Rule[] {
  const rules: Rule[] = [];

  // ── MARQUEE ──────────────────────────────────────────────────────────────

  rules.push({
    id: 'gc30_mingo',
    displayName: 'Mingo (GC30)',
    description: "The oldest active cache in the world. The 7th cache ever placed (May 11, 2000).",
    severity: 'marquee',
    defaultEnabled: true,
    ruleType: 'enumerated',
    codeSet: new Set(['GC30']),
  });

  rules.push({
    id: 'new_country',
    displayName: 'New country',
    description: "A country you've never logged a find in before.",
    severity: 'marquee',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testNewCountry,
  });

  rules.push({
    id: 'milestone_find',
    displayName: 'Milestone find',
    description: "A round-number find — 500th, 1000th, 5000th, 10000th, etc.",
    severity: 'marquee',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testMilestoneFind,
  });

  rules.push({
    id: 'oldest_active_per_state',
    displayName: 'Oldest active in state/province',
    description: "One of the oldest active caches in a US state or Canadian province/territory.",
    severity: 'marquee',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testOldestActivePerState,
  });

  rules.push({
    id: 'oldest_active_per_country',
    displayName: 'Oldest active in country',
    description: "One of the oldest active caches in its country.",
    severity: 'marquee',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testOldestActivePerCountry,
  });

  rules.push({
    id: 'cache_across_america',
    displayName: 'Cache Across America',
    description: "A cache on the Cache Across America series — one per state.",
    severity: 'marquee',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testCacheAcrossAmerica,
  });

  rules.push({
    id: 'cache_odyssey',
    displayName: 'Cache Odyssey',
    description: "A cache on the Cache Odyssey collection.",
    severity: 'marquee',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testCacheOdyssey,
  });

  rules.push({
    id: 'state_completion',
    displayName: 'State completion',
    description: "A trip find that completed your county coverage of a US state.",
    severity: 'marquee',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testStateCompletion,
  });

  rules.push({
    id: 'rare_cache_type',
    displayName: 'Rare cache types',
    description: "Project APE, Mega/Giga-Event, Webcam, GPS Adventures Maze, " +
                 "Geocaching HQ, Locationless, Block Party, and Lost and Found caches.",
    severity: 'marquee',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testRareCacheType,
  });

  // Mega/Giga-Event gets its own rule in v1 (new for REPORT v1)
  rules.push({
    id: 'mega_giga_event',
    displayName: 'Mega/Giga-Event',
    description: "A Mega-Event or Giga-Event Cache attended during the trip.",
    severity: 'marquee',
    defaultEnabled: true,
    ruleType: 'categorical',
    test: testMegaGigaEvent,
  });

  // ── FEATURED ─────────────────────────────────────────────────────────────

  rules.push({
    id: 'placed_year_2000',
    displayName: 'Year-2000 caches',
    description: "Caches placed during geocaching's founding year (2000).",
    severity: 'featured',
    defaultEnabled: true,
    ruleType: 'categorical',
    test: testPlacedYear(2000),
  });

  rules.push({
    id: 'placed_year_2001',
    displayName: 'Year-2001 caches',
    description: "Caches placed in 2001 — the second year of the hobby.",
    severity: 'featured',
    defaultEnabled: true,
    ruleType: 'categorical',
    test: testPlacedYear(2001),
  });

  rules.push({
    id: 'type_virtual',
    displayName: 'Old Virtuals',
    description: "Grandfathered Virtual caches.",
    severity: 'featured',
    defaultEnabled: true,
    ruleType: 'categorical',
    test: testCacheType('Virtual Cache', 'Grandfathered Virtual cache.'),
  });

  rules.push({
    id: 'new_state',
    displayName: 'New state/province',
    description: "A state or province you've never logged a find in before.",
    severity: 'featured',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testNewState,
  });

  rules.push({
    id: 'new_county',
    displayName: 'New county',
    description: "A county you've never logged a find in before.",
    severity: 'featured',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testNewCounty,
  });

  rules.push({
    id: 'new_cache_type',
    displayName: 'New cache type',
    description: "A cache type you've never found before.",
    severity: 'featured',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testNewCacheType,
  });

  rules.push({
    id: 'high_fav_1000',
    displayName: '1000+ favorite points',
    description: "Caches with 1000 or more favorite points.",
    severity: 'featured',
    defaultEnabled: true,
    ruleType: 'categorical',
    test: testHighFav(1000),
  });

  rules.push({
    id: 'high_fav_500',
    displayName: '500+ favorite points',
    description: "Caches with 500 or more favorite points.",
    severity: 'featured',
    defaultEnabled: true,
    ruleType: 'categorical',
    test: testHighFav(500),
  });

  rules.push({
    id: 'high_fav_250',
    displayName: '250+ favorite points',
    description: "Caches with 250 or more favorite points.",
    severity: 'featured',
    defaultEnabled: true,
    ruleType: 'categorical',
    test: testHighFav(250),
  });

  rules.push({
    id: 'jasmer_grid_fill',
    displayName: 'Jasmer grid fill',
    description: "A cache that filled a previously-empty Jasmer cell (month × year placed).",
    severity: 'featured',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testJasmerGridFill,
  });

  rules.push({
    id: 'dt_grid_fill',
    displayName: 'D/T grid fill',
    description: "A cache that filled a previously-empty D/T grid cell.",
    severity: 'featured',
    defaultEnabled: true,
    ruleType: 'computed',
    test: testDtGridFill,
  });

  return rules;
}

// ============================================================================
// Rule evaluation
// ============================================================================

/**
 * Evaluate a single rule against a single waypoint.
 * Python reference: Rule.evaluate()
 */
export function evaluateRule(
  rule: Rule,
  wpt: Waypoint,
  ctx: RuleContext,
): RuleMatch | null {
  if (rule.ruleType === 'enumerated') {
    if (rule.codeSet?.has(wpt.gcCode)) {
      return { waypoint: wpt, note: rule.description };
    }
    return null;
  }

  if (rule.test) {
    const result = rule.test(wpt, ctx);
    if (result !== null) {
      return { waypoint: wpt, note: result || rule.description };
    }
  }

  return null;
}

/**
 * Evaluate all enabled rules against all trip finds.
 * Returns only rules that fired (have at least one match).
 *
 * Handles enabled_rules filtering with unknown-ID warnings, exactly
 * mirroring the Python generate.py logic.
 *
 * Python reference: evaluate_all_rules() + enabled_rules filtering in main()
 */
export function evaluateAllRules(
  tripFinds: Waypoint[],
  rules: Rule[],
  ctx: RuleContext,
  enabledIds?: string[],
): { results: RuleResult[]; warnings: string[] } {
  const warnings: string[] = [];
  let activeRules = rules;

  if (enabledIds && enabledIds.length > 0) {
    const knownIds = new Set(rules.map(r => r.id));
    const unknownIds = enabledIds.filter(id => !knownIds.has(id));
    if (unknownIds.length > 0) {
      warnings.push(
        `enabled_rules contains ${unknownIds.length} unknown rule ID(s): ` +
        unknownIds.join(', ') +
        `. These may have been renamed. Set enabled_rules to [] to use all current rules.`
      );
    }
    activeRules = rules.filter(r => enabledIds.includes(r.id));
    if (activeRules.length === 0) {
      warnings.push(
        `enabled_rules filtered out every rule. No rule evaluation will run. ` +
        `Set enabled_rules to [] to use defaults.`
      );
    }
  }

  const results: RuleResult[] = [];

  for (const rule of activeRules) {
    if (!rule.defaultEnabled) continue;
    const matches: RuleMatch[] = [];
    for (const wpt of tripFinds) {
      const match = evaluateRule(rule, wpt, ctx);
      if (match) matches.push(match);
    }
    if (matches.length > 0) {
      results.push({ rule, matches });
    }
  }

  return { results, warnings };
}
