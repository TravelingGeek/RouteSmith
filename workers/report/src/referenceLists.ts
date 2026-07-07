/**
 * referenceLists.ts — Bookmark list reference data loader.
 *
 * In v1, the four bookmark-list GPX files are stored in R2 and fetched at
 * runtime. This module provides:
 *   1. A parser that extracts GC code → { name, state, country } from GPX text.
 *   2. A loader that fetches from R2 (or local Workers KV / env binding).
 *   3. Accessor functions that mirror Python's state_data.py interface.
 *
 * Python reference: state_data.py
 *
 * R2 key convention (matches ReferenceLists/ folder in repo):
 *   ReferenceLists/oldest_active_per_state.gpx
 *   ReferenceLists/oldest_active_per_country.gpx
 *   ReferenceLists/cache_across_america.gpx
 *   ReferenceLists/cache_odyssey.gpx
 */

export interface ReferenceEntry {
  name: string;
  state: string;
  country: string;
}

export type ReferenceMap = Map<string, ReferenceEntry>;

// ============================================================================
// GPX parser for bookmark lists
// ============================================================================

/**
 * Parse a bookmark-list GPX text into a ReferenceMap.
 * Uses regex-based parsing — no DOMParser — compatible with Cloudflare Workers runtime.
 * Returns an empty Map (never throws) on parse failure.
 */
export function parseReferenceGpx(
  xml: string,
  filename: string,
): { map: ReferenceMap; warning: string | null } {
  if (!xml?.trim()) {
    return { map: new Map(), warning: `${filename} is empty; the rule that depends on it will not fire.` };
  }
  try {
    const map: ReferenceMap = new Map();
    const wptChunks = xml.split('</wpt>');

    function between(str: string, open: string, close: string): string {
      const s = str.indexOf(open);
      if (s === -1) return '';
      const e = str.indexOf(close, s + open.length);
      if (e === -1) return '';
      return str.slice(s + open.length, e).trim();
    }

    for (const chunk of wptChunks) {
      const gcCode = between(chunk, '<name>', '</name>');
      if (!gcCode || !gcCode.startsWith('GC')) continue;
      const cacheStart = chunk.indexOf('<groundspeak:cache');
      const cacheChunk = cacheStart !== -1 ? chunk.slice(cacheStart) : chunk;
      map.set(gcCode, {
        name:    between(cacheChunk, '<groundspeak:name>',    '</groundspeak:name>'),
        state:   between(cacheChunk, '<groundspeak:state>',   '</groundspeak:state>'),
        country: between(cacheChunk, '<groundspeak:country>', '</groundspeak:country>'),
      });
    }

    return { map, warning: map.size === 0 ? `${filename} contained no valid GC codes.` : null };
  } catch (e) {
    return { map: new Map(), warning: `${filename} could not be parsed; the rule that depends on it will not fire.` };
  }
}

// ============================================================================
// Loaded reference data container
// ============================================================================

export interface ReferenceLists {
  oldestActivePerState: ReferenceMap;
  oldestActivePerCountry: ReferenceMap;
  cacheAcrossAmerica: ReferenceMap;
  cacheOdyssey: ReferenceMap;
  warnings: string[];
}

/**
 * Build a ReferenceLists object from pre-fetched GPX texts.
 * Pass null for any list that wasn't available (rule silently won't fire).
 *
 * Called from the Worker pipeline after fetching from R2.
 */
export function buildReferenceLists(sources: {
  oldestActivePerState: string | null;
  oldestActivePerCountry: string | null;
  cacheAcrossAmerica: string | null;
  cacheOdyssey: string | null;
}): ReferenceLists {
  const warnings: string[] = [];

  function load(xml: string | null, filename: string): ReferenceMap {
    if (!xml) {
      warnings.push(`ReferenceLists/${filename} not found; rule will not fire.`);
      return new Map();
    }
    const { map, warning } = parseReferenceGpx(xml, filename);
    if (warning) warnings.push(warning);
    return map;
  }

  return {
    oldestActivePerState:   load(sources.oldestActivePerState,   'oldest_active_per_state.gpx'),
    oldestActivePerCountry: load(sources.oldestActivePerCountry, 'oldest_active_per_country.gpx'),
    cacheAcrossAmerica:     load(sources.cacheAcrossAmerica,     'cache_across_america.gpx'),
    cacheOdyssey:           load(sources.cacheOdyssey,           'cache_odyssey.gpx'),
    warnings,
  };
}

// ============================================================================
// Accessors used to populate RuleContext
// ============================================================================

/**
 * Build the rule-context entries for all four bookmark lists.
 * Injects them directly into the context object passed by reference.
 *
 * In Python these were module-level lookup functions. In TS they become
 * Maps attached to the RuleContext, accessed by the rule test functions.
 */
export function injectReferenceContext(
  ctx: Record<string, unknown>,
  lists: ReferenceLists,
): void {
  // oldestActivePerState: gcCode → state name
  const stateMap = new Map<string, string>();
  for (const [code, entry] of lists.oldestActivePerState) {
    if (entry.state) stateMap.set(code, entry.state);
  }
  ctx['oldestActivePerState'] = stateMap;

  // oldestActivePerCountry: gcCode → country name
  const countryMap = new Map<string, string>();
  for (const [code, entry] of lists.oldestActivePerCountry) {
    if (entry.country) countryMap.set(code, entry.country);
  }
  ctx['oldestActivePerCountry'] = countryMap;

  // cacheAcrossAmerica: gcCode → { state }
  const caaMap = new Map<string, { state?: string }>();
  for (const [code, entry] of lists.cacheAcrossAmerica) {
    caaMap.set(code, { state: entry.state || undefined });
  }
  ctx['cacheAcrossAmerica'] = caaMap;

  // cacheOdyssey: gcCode Set
  ctx['cacheOdyssey'] = new Set(lists.cacheOdyssey.keys());
}

// ============================================================================
// R2 fetch helper (Workers environment)
// ============================================================================

/**
 * Fetch all four reference list GPX files from R2.
 * `bucket` is the R2Bucket binding from the Worker env.
 *
 * Usage in the Worker:
 *   const lists = await fetchReferenceListsFromR2(env.REPORT_BUCKET);
 */
export async function fetchReferenceListsFromR2(
  bucket: R2Bucket,
): Promise<ReferenceLists> {
  const keys = {
    oldestActivePerState:   'ReferenceLists/oldest_active_per_state.gpx',
    oldestActivePerCountry: 'ReferenceLists/oldest_active_per_country.gpx',
    cacheAcrossAmerica:     'ReferenceLists/cache_across_america.gpx',
    cacheOdyssey:           'ReferenceLists/cache_odyssey.gpx',
  };

  async function fetchKey(key: string): Promise<string | null> {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return obj.text();
  }

  const [oState, oCountry, caa, odyssey] = await Promise.all([
    fetchKey(keys.oldestActivePerState),
    fetchKey(keys.oldestActivePerCountry),
    fetchKey(keys.cacheAcrossAmerica),
    fetchKey(keys.cacheOdyssey),
  ]);

  return buildReferenceLists({
    oldestActivePerState:   oState,
    oldestActivePerCountry: oCountry,
    cacheAcrossAmerica:     caa,
    cacheOdyssey:           odyssey,
  });
}

// R2Bucket type stub (filled in by the wrangler-generated types at build time)
interface R2Bucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}
