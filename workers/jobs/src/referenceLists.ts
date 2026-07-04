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

const NS_GS = 'http://www.groundspeak.com/cache/1/0/1';
const NS_GPX_10 = 'http://www.topografix.com/GPX/1/0';
const NS_GPX_11 = 'http://www.topografix.com/GPX/1/1';

function getText(el: Element, ns: string, local: string): string {
  const found = el.getElementsByTagNameNS(ns, local);
  return found[0]?.textContent?.trim() ?? '';
}

/**
 * Parse a bookmark-list GPX text into a ReferenceMap.
 * Returns an empty Map (never throws) on parse failure.
 * Python reference: _load_bookmark_gpx()
 */
export function parseReferenceGpx(
  xml: string,
  filename: string,
  parser: DOMParser = new DOMParser(),
): { map: ReferenceMap; warning: string | null } {
  let doc: Document;
  try {
    doc = parser.parseFromString(xml, 'application/xml');
  } catch {
    return {
      map: new Map(),
      warning: `${filename} could not be parsed; the rule that depends on it will not fire.`,
    };
  }

  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    return {
      map: new Map(),
      warning: `${filename} XML parse error; the rule that depends on it will not fire.`,
    };
  }

  const root = doc.documentElement;
  const gpxNs = root.namespaceURI === NS_GPX_11 ? NS_GPX_11 : NS_GPX_10;
  const wpts = doc.getElementsByTagNameNS(gpxNs, 'wpt');
  const map: ReferenceMap = new Map();

  for (let i = 0; i < wpts.length; i++) {
    const wpt = wpts[i];
    const nameEl = wpt.getElementsByTagNameNS(gpxNs, 'name')[0];
    const gcCode = nameEl?.textContent?.trim();
    if (!gcCode) continue;

    const cacheEls = wpt.getElementsByTagNameNS(NS_GS, 'cache');
    const cacheEl = cacheEls[0];
    if (!cacheEl) continue;

    map.set(gcCode, {
      name: getText(cacheEl, NS_GS, 'name'),
      state: getText(cacheEl, NS_GS, 'state'),
      country: getText(cacheEl, NS_GS, 'country'),
    });
  }

  return { map, warning: null };
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
