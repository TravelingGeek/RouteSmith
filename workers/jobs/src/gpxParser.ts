/**
 * gpxParser.ts — GPX parsing for the Routesmith REPORT module.
 *
 * Handles both Project-GC My Finds GPX (preferred — includes gsak:County and
 * FavPoints) and geocaching.com My Finds Pocket Query format.
 *
 * In the browser / Cloudflare Workers environment, ZIP decompression uses
 * fflate. XML parsing uses DOMParser (available in both environments via
 * Cloudflare's HTMLRewriter / Workers runtime). For Node.js test contexts,
 * a lightweight DOMParser polyfill (e.g. @xmldom/xmldom) works as a drop-in.
 *
 * Python reference: gpx_parser.py
 */

import type { Waypoint } from './types.js';
// fflate and fast-xml-parser loaded lazily on first use
import { STATE_ABBREVIATIONS } from './types.js';

// ============================================================================
// Namespace constants
// ============================================================================

const NS_GPX_10 = 'http://www.topografix.com/GPX/1/0';
const NS_GPX_11 = 'http://www.topografix.com/GPX/1/1';
const NS_GS     = 'http://www.groundspeak.com/cache/1/0/1';
const NS_GSAK   = 'http://www.gsak.net/xmlv1/6';

// ============================================================================
// Error type
// ============================================================================

export class GpxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpxParseError';
  }
}

// ============================================================================
// Date parsing
// ============================================================================

/**
 * Parse an ISO-8601 datetime string into a tz-naive Date (UTC wall clock).
 * Mirrors Python's _parse_iso_datetime which strips tzinfo.
 */
function parseIsoDatetime(text: string | null | undefined): Date | null {
  if (!text) return null;
  const s = text.trim().replace('Z', '+00:00');
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  // Return a Date whose UTC fields represent the wall-clock value.
  // (JavaScript Date is always UTC internally; "tz-naive" just means we
  // never use getTimezoneOffset() and always compare UTC fields.)
  return d;
}

// ============================================================================
// County suffix stripping
// ============================================================================

/**
 * Extract county name from gsak:County string, removing "(TX)" state suffix.
 * Examples:
 *   "Fort Bend County (TX)" → "Fort Bend County"
 *   "Cook County"           → "Cook County"
 */
function stripCountySuffix(text: string): string {
  const trimmed = text.trim();
  if (trimmed.endsWith(')')) {
    const parenIdx = trimmed.lastIndexOf('(');
    if (parenIdx !== -1) return trimmed.slice(0, parenIdx).trim();
  }
  return trimmed;
}

// ============================================================================
// Single <wpt> element parser
// ============================================================================

function getTextNS(parent: Element, ns: string, localName: string): string | null {
  // getElementsByTagNameNS is available in both DOMParser environments
  const els = parent.getElementsByTagNameNS(ns, localName);
  if (els.length === 0) return null;
  return els[0].textContent?.trim() ?? null;
}

function parseFloat_(s: string | null): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseInt_(s: string | null): number {
  if (!s) return 0;
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Parse a single <wpt> element.
 *
 * @param wpt        The <wpt> Element from the parsed GPX Document.
 * @param finderName Optional username for find-date extraction from logs.
 * @param gpxNs      The GPX namespace in use (1/0 or 1/1).
 * @returns          Waypoint, or null if element is not a GC cache.
 */
export function parseWaypoint(
  wpt: Element,
  finderName: string | null,
  gpxNs: string,
): Waypoint | null {
  const nameEl = wpt.getElementsByTagNameNS(gpxNs, 'name')[0];
  const gcCode = nameEl?.textContent?.trim() ?? '';
  if (!gcCode.startsWith('GC')) return null;

  const lat = parseFloat(wpt.getAttribute('lat') ?? '');
  const lon = parseFloat(wpt.getAttribute('lon') ?? '');
  if (isNaN(lat) || isNaN(lon)) return null;

  const timeEl = wpt.getElementsByTagNameNS(gpxNs, 'time')[0];
  const placementTime = parseIsoDatetime(timeEl?.textContent);

  const symEl = wpt.getElementsByTagNameNS(gpxNs, 'sym')[0];
  const sym = symEl?.textContent?.trim() ?? null;

  // Groundspeak cache element
  const cacheEls = wpt.getElementsByTagNameNS(NS_GS, 'cache');
  const cacheEl = cacheEls.length > 0 ? cacheEls[0] : null;

  let cacheType: string | null = null;
  let container: string | null = null;
  let difficulty: number | null = null;
  let terrain: number | null = null;
  let country: string | null = null;
  let state: string | null = null;
  let cacheOwner: string | null = null;
  let archived = false;
  let findDate: Date | null = null;
  let finderLogText: string | null = null;
  let cacheName = gcCode;
  const attributes = new Set<number>();

  if (cacheEl) {
    archived = cacheEl.getAttribute('archived') === 'True';
    cacheName = getTextNS(cacheEl, NS_GS, 'name') ?? gcCode;
    cacheType = getTextNS(cacheEl, NS_GS, 'type');
    container = getTextNS(cacheEl, NS_GS, 'container');
    difficulty = parseFloat_(getTextNS(cacheEl, NS_GS, 'difficulty'));
    terrain    = parseFloat_(getTextNS(cacheEl, NS_GS, 'terrain'));
    country    = getTextNS(cacheEl, NS_GS, 'country');
    state      = getTextNS(cacheEl, NS_GS, 'state');
    cacheOwner = getTextNS(cacheEl, NS_GS, 'owner');

    // Attributes
    const attrContainers = cacheEl.getElementsByTagNameNS(NS_GS, 'attributes');
    if (attrContainers.length > 0) {
      const attrEls = attrContainers[0].getElementsByTagNameNS(NS_GS, 'attribute');
      for (let i = 0; i < attrEls.length; i++) {
        const id = parseInt_(attrEls[i].getAttribute('id'));
        if (id) attributes.add(id);
      }
    }

    // Logs — extract finder's "Found it" date
    if (finderName) {
      const logContainers = cacheEl.getElementsByTagNameNS(NS_GS, 'logs');
      if (logContainers.length > 0) {
        const logs = logContainers[0].getElementsByTagNameNS(NS_GS, 'log');
        for (let i = 0; i < logs.length; i++) {
          const log = logs[i];
          const logFinder = getTextNS(log, NS_GS, 'finder');
          const logType   = getTextNS(log, NS_GS, 'type');
          const logDateS  = getTextNS(log, NS_GS, 'date');
          const logText   = getTextNS(log, NS_GS, 'text');

          const nameMatch = logFinder?.toLowerCase() === finderName.toLowerCase();
          const foundTypes = new Set(['Found it', 'Attended', 'Webcam Photo Taken']);
          if (nameMatch && logType && foundTypes.has(logType)) {
            findDate = parseIsoDatetime(logDateS);
            finderLogText = logText;
            break;
          }
        }
      }
    }
  }

  // GSAK extension fields
  let county: string | null = null;
  let favoritePoints = 0;
  const gsakEls = wpt.getElementsByTagNameNS(NS_GSAK, 'wptExtension');
  if (gsakEls.length > 0) {
    const gsakEl = gsakEls[0];
    const countyText = getTextNS(gsakEl, NS_GSAK, 'County');
    if (countyText) county = stripCountySuffix(countyText);
    const fpText = getTextNS(gsakEl, NS_GSAK, 'FavPoints');
    if (fpText) favoritePoints = parseInt_(fpText);
  }

  return {
    gcCode,
    name: cacheName,
    cacheType,
    lat,
    lon,
    container,
    difficulty,
    terrain,
    country,
    state,
    county,
    placementTime,
    findDate,
    favoritePoints,
    cacheOwner,
    attributes,
    finderLogText,
    sym,
    archived,
  };
}

// ============================================================================
// Document → Waypoint[] walker
// ============================================================================

function detectGpxNs(doc: Document): string {
  const root = doc.documentElement;
  if (root.namespaceURI === NS_GPX_11) return NS_GPX_11;
  return NS_GPX_10;
}

function parseDocument(doc: Document, finderName: string | null): Waypoint[] {
  const ns = detectGpxNs(doc);
  const wpts = doc.getElementsByTagNameNS(ns, 'wpt');
  const result: Waypoint[] = [];
  for (let i = 0; i < wpts.length; i++) {
    const w = parseWaypoint(wpts[i], finderName, ns);
    if (w) result.push(w);
  }
  return result;
}

// ============================================================================
// Public parse functions
// ============================================================================

/**
 * Parse a GPX XML string.
 * Uses DOMParser when available (browser), falls back to fast-xml-parser
 * (Cloudflare Workers runtime where DOMParser is unavailable).
 */
/**
 * Parse a GPX XML string using fast-xml-parser.
 * Works in both browser and Cloudflare Workers (no DOMParser dependency).
 * Used by parseGpxTexts for all Worker-side pipeline runs.
 */
export async function parseGpxTextAsync(
  xmlText: string,
  finderName: string | null = null,
): Promise<Waypoint[]> {
  return parseGpxTextFxp(xmlText, finderName);
}

/**
 * Parse a GPX XML string using DOMParser (browser only).
 * Use parseGpxTextAsync for Worker-compatible parsing.
 */
export function parseGpxText(
  xmlText: string,
  finderName: string | null = null,
  parser: DOMParser = new DOMParser(),
): Waypoint[] {
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new GpxParseError(`Invalid GPX XML: ${parseErr.textContent?.slice(0, 200)}`);
  return parseDocument(doc, finderName);
}

/**
 * Parse multiple GPX texts and return a deduplicated list.
 * Worker-compatible (async, uses fast-xml-parser fallback).
 * Later items override earlier ones (last-write-wins by GC code).
 */
export async function parseGpxTexts(
  texts: string[],
  finderName: string | null = null,
): Promise<Waypoint[]> {
  const seen = new Map<string, Waypoint>();
  for (const text of texts) {
    for (const wpt of await parseGpxTextAsync(text, finderName)) {
      seen.set(wpt.gcCode, wpt);
    }
  }
  return Array.from(seen.values());
}

// ============================================================================
// ZIP support
// ============================================================================

/**
 * Parse GPX files from a ZIP archive (ArrayBuffer).
 * Requires fflate: `import { unzipSync } from 'fflate'`
 *
 * In the Workers environment, install fflate as a dependency:
 *   npm install fflate
 *
 * This function is async to support future streaming ZIP decompression.
 */
export async function parseGpxZip(
  zipBuffer: ArrayBuffer,
  finderName: string | null = null,
): Promise<Waypoint[]> {
  // Dynamic import keeps fflate tree-shakeable when ZIP support isn't needed.
  const { unzipSync } = await import('fflate');

  const uint8 = new Uint8Array(zipBuffer);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(uint8);
  } catch (e) {
    throw new GpxParseError(`ZIP decompression failed: ${(e as Error).message}`);
  }

  const gpxEntries = Object.entries(files).filter(([name]) =>
    name.toLowerCase().endsWith('.gpx')
  );
  if (gpxEntries.length === 0) {
    throw new GpxParseError(
      `ZIP archive contains no .gpx files. Members: ${Object.keys(files).join(', ')}`
    );
  }

  const decoder = new TextDecoder('utf-8');
  const texts = gpxEntries.map(([, data]) => decoder.decode(data));
  return parseGpxTexts(texts, finderName);
}

// ============================================================================
// Field completeness check
// ============================================================================

/**
 * Inspect a parsed waypoint list for field completeness.
 * Mirrors Python's _check_gpx_completeness.
 * Returns flags the renderer uses to suppress sections with missing data.
 */
export function checkGpxCompleteness(waypoints: Waypoint[]): {
  hasCounty: boolean;
  hasFp: boolean;
  warnings: string[];
} {
  if (waypoints.length === 0) return { hasCounty: false, hasFp: false, warnings: [] };

  const n = waypoints.length;
  const countyCount = waypoints.filter(w => w.county).length;
  const fpCount = waypoints.filter(w => w.favoritePoints > 0).length;
  const hasCounty = countyCount / n >= 0.10;
  const hasFp = fpCount / n >= 0.10;
  const warnings: string[] = [];

  if (!hasCounty) {
    warnings.push(
      `${countyCount} of ${n} waypoints have county data. ` +
      `This looks like a gc.com My Finds GPX. County-based features will be suppressed. ` +
      `Use a Project-GC My Finds export for full features.`
    );
  }
  if (!hasFp) {
    warnings.push(
      `${fpCount} of ${n} waypoints have favorite-point data. ` +
      `FP-based features will be suppressed. Use a Project-GC My Finds export for full features.`
    );
  }

  return { hasCounty, hasFp, warnings };
}

// ============================================================================
// Data-through extraction
// ============================================================================

/**
 * Return the ISO date string of the most recent find in a waypoint list.
 * Used to populate gpx_files.data_through on upload confirm.
 * Returns null if no waypoints have a findDate.
 */
export function extractDataThrough(waypoints: Waypoint[]): string | null {
  let latest: Date | null = null;
  for (const w of waypoints) {
    if (!w.findDate) continue;
    if (!latest || w.findDate > latest) latest = w.findDate;
  }
  return latest ? latest.toISOString().slice(0, 10) : null;
}

// ============================================================================
// Workers-compatible metadata extraction (no DOMParser)
// ============================================================================

/**
 * Extract find dates and find count from GPX text using fast-xml-parser.
 * Used in the Workers confirm endpoint where DOMParser is unavailable.
 * Returns { findCount, dataThrough } without full waypoint parsing.
 */
export async function extractGpxMetadata(gpxText: string): Promise<{
  findCount: number;
  dataThrough: string | null;
  format: string;
}> {
  const { XMLParser } = await import('fast-xml-parser');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name: string) => name === 'wpt' || name === 'log',
    parseAttributeValue: true,
    processEntities: {
      enabled: true,
      maxEntityCount: 100000,  // raise limit well above any real GPX file
    } as unknown as boolean,
    htmlEntities: false,
  });

  const doc = parser.parse(gpxText);

  // Detect format
  let format = 'unknown';
  const raw = JSON.stringify(doc);
  if (raw.includes('gsak.net')) format = 'pgc';
  else if (raw.includes('geocaching.com') || raw.includes('Groundspeak')) format = 'gccom';

  // Navigate to wpt array — GPX root varies by namespace prefix
  const root = doc.gpx ?? doc['gpx:gpx'] ?? Object.values(doc)[0];
  const wpts: unknown[] = root?.wpt ?? [];

  if (!Array.isArray(wpts) || wpts.length === 0) {
    return { findCount: 0, dataThrough: null, format };
  }

  // Extract find dates from logs
  let latest: Date | null = null;
  let findCount = 0;

  for (const wpt of wpts) {
    if (typeof wpt !== 'object' || wpt === null) continue;
    const w = wpt as Record<string, unknown>;

    // Navigate to groundspeak:cache > groundspeak:logs > groundspeak:log
    const cacheNode = findNode(w, 'cache');
    if (!cacheNode) continue;

    const logsNode = findNode(cacheNode as Record<string, unknown>, 'logs');
    if (!logsNode) continue;

    const logs = findArray(logsNode as Record<string, unknown>, 'log');
    for (const log of logs) {
      const logObj = log as Record<string, unknown>;
      const logType = findText(logObj, 'type') ?? '';
      const foundTypes = ['Found it', 'Attended', 'Webcam Photo Taken'];
      if (!foundTypes.includes(logType)) continue;

      findCount++;
      const dateStr = findText(logObj, 'date');
      if (dateStr) {
        const d = new Date(dateStr.trim());
        if (!isNaN(d.getTime())) {
          if (!latest || d > latest) latest = d;
        }
      }
      break; // first matching log per wpt
    }
  }

  const dataThrough = latest ? latest.toISOString().slice(0, 10) : null;
  return { findCount, dataThrough, format };
}

// Helpers for navigating fast-xml-parser output (which strips namespace prefixes)
function findNode(obj: Record<string, unknown>, localName: string): unknown {
  for (const key of Object.keys(obj)) {
    const stripped = key.includes(':') ? key.split(':').pop()! : key;
    if (stripped === localName) return obj[key];
  }
  return null;
}

function findText(obj: Record<string, unknown>, localName: string): string | null {
  const val = findNode(obj, localName);
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    const o = val as Record<string, unknown>;
    if ('#text' in o) return String(o['#text']);
  }
  return null;
}

function findArray(obj: Record<string, unknown>, localName: string): unknown[] {
  const val = findNode(obj, localName);
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

// ============================================================================
// fast-xml-parser based full waypoint parser (Workers runtime fallback)
// ============================================================================

// Extract plain text from a fast-xml-parser node (handles string, number,
// and object with #text property from attribute-bearing elements).
function extractText(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val.trim() || null;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    const o = val as Record<string, unknown>;
    if ('#text' in o) return String(o['#text']).trim() || null;
  }
  return null;
}

async function parseGpxTextFxp(
  xmlText: string,
  finderName: string | null,
): Promise<Waypoint[]> {
  const { XMLParser } = await import('fast-xml-parser');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name: string) => ['wpt', 'log', 'attribute'].includes(name),
    parseAttributeValue: true,
    processEntities: {
      enabled: true,
      maxEntityCount: 100000,
    } as unknown as boolean,
    htmlEntities: false,
    removeNSPrefix: true, // strips groundspeak:, gsak: etc — simplifies traversal
  });

  const doc = parser.parse(xmlText);
  const root = doc.gpx ?? Object.values(doc)[0] as Record<string, unknown>;
  const wpts: unknown[] = Array.isArray(root?.wpt) ? root.wpt as unknown[] : [];

  const FOUND_TYPES = new Set(['Found it', 'Attended', 'Webcam Photo Taken']);
  const results: Waypoint[] = [];

  for (const w of wpts) {
    const wptObj = w as Record<string, unknown>;
    const name = (wptObj['name'] as string | undefined)?.trim() ?? '';
    if (!name.startsWith('GC')) continue;

    const lat = parseFloat(String(wptObj['@_lat'] ?? ''));
    const lon = parseFloat(String(wptObj['@_lon'] ?? ''));
    if (isNaN(lat) || isNaN(lon)) continue;

    const timeStr = wptObj['time'] as string | undefined;
    const placementTime = parseIsoDatetime(timeStr);

    const sym = (wptObj['sym'] as string | undefined) ?? null;

    // Groundspeak cache element (namespace stripped by removeNSPrefix)
    const cache = wptObj['cache'] as Record<string, unknown> | undefined;
    let cacheType: string | null = null;
    let container: string | null = null;
    let difficulty: number | null = null;
    let terrain: number | null = null;
    let country: string | null = null;
    let state: string | null = null;
    let cacheOwner: string | null = null;
    let cacheName = name;
    let archived = false;
    let findDate: Date | null = null;
    let finderLogText: string | null = null;
    const attributes = new Set<number>();

    if (cache) {
      archived = cache['@_archived'] === 'True' || cache['@_archived'] === true;
      cacheName = extractText(cache['name']) ?? name;
      cacheType = extractText(cache['type']);
      container = extractText(cache['container']);
      difficulty = parseFloat_(extractText(cache['difficulty']));
      terrain    = parseFloat_(extractText(cache['terrain']));
      country    = extractText(cache['country']);
      state      = extractText(cache['state']);
      cacheOwner = extractText(cache['owner']);

      // Attributes
      const attrsContainer = cache['attributes'] as Record<string, unknown> | undefined;
      if (attrsContainer) {
        const attrList = Array.isArray(attrsContainer['attribute'])
          ? attrsContainer['attribute'] as Record<string, unknown>[]
          : [];
        for (const attr of attrList) {
          const id = parseInt_(String(attr['@_id'] ?? ''));
          if (id) attributes.add(id);
        }
      }

      // Logs
      if (finderName) {
        const logsContainer = cache['logs'] as Record<string, unknown> | undefined;
        const logs = Array.isArray(logsContainer?.['log'])
          ? logsContainer!['log'] as Record<string, unknown>[]
          : [];
        for (const log of logs) {
          const finderName_ = extractText(log['finder']) ?? '';
          const logType = extractText(log['type']) ?? '';
          const logDate = extractText(log['date']) ?? '';
          const logTextStr = extractText(log['text']);

          if (finderName_.toLowerCase() === finderName.toLowerCase() && FOUND_TYPES.has(logType)) {
            findDate = parseIsoDatetime(logDate);
            finderLogText = logTextStr;
            break;
          }
        }
      }
    }

    // GSAK extension (namespace stripped)
    let county: string | null = null;
    let favoritePoints = 0;
    const ext = wptObj['wptExtension'] as Record<string, unknown> | undefined;
    if (ext) {
      const countyText = ext['County'] as string | undefined;
      if (countyText) county = stripCountySuffix(countyText);
      const fp = ext['FavPoints'] as string | number | undefined;
      if (fp !== undefined) favoritePoints = parseInt_(String(fp));
    }

    results.push({
      gcCode: name,
      name: cacheName,
      cacheType,
      lat,
      lon,
      container,
      difficulty,
      terrain,
      country,
      state,
      county,
      placementTime,
      findDate,
      favoritePoints,
      cacheOwner,
      attributes,
      finderLogText,
      sym,
      archived,
    });
  }

  return results;
}
