/**
 * renderer.ts — HTML report renderer for the Routesmith REPORT module.
 *
 * Produces a single self-contained HTML string with embedded CSS and inline
 * SVG charts. Output is semantically and visually identical to the Python
 * reference implementation.
 *
 * Python reference: report.py
 */

import type {
  TripInput,
  PlayerStats,
  CountiesData,
  FieldAvailability,
} from './types.js';
import type { RuleResult, RuleMatch } from './types.js';
import type { Waypoint } from './types.js';
import { STATE_ABBREVIATIONS } from './types.js';
import type { JasmerCellState } from './statistics.js';
import {
  chartCumulativeFinds,
  chartDailyRhythm,
  chartCountiesByState,
  chartJasmerGrid,
  chartCacheTypes,
  dailyRhythmLegend,
} from './charts.js';

// ============================================================================
// Palette
// ============================================================================

const C_INK        = '#1a2733';
const C_INK_SOFT   = '#475463';
const C_INK_FAINT  = '#8b95a1';
const C_NAVY       = '#1f4068';
const C_GS_GREEN   = '#01884e';
const C_GS_GREEN_S = '#a8d8b8';
const C_NAVY_DEEP  = '#142b48';
const C_RULE       = '#d6dce3';
const C_PAPER      = '#fbfaf6';
const C_BG_PANEL   = '#f5f2ea';

// ============================================================================
// Embedded CSS (mirrors report.py CSS constant exactly)
// ============================================================================

const CSS = `
* { box-sizing: border-box; }
html, body {
    margin: 0; padding: 0;
    background: ${C_PAPER}; color: ${C_INK};
}
body {
    font-family: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
    font-size: 17px; line-height: 1.65;
    -webkit-font-smoothing: antialiased;
}
.page { max-width: 1100px; margin: 0 auto; padding: 64px 56px 96px; }
@media (max-width: 720px) { .page { padding: 32px 24px 48px; } }
.col { max-width: 640px; }
.col-wide { max-width: 880px; }
.hero { margin-bottom: 64px; padding-bottom: 32px; border-bottom: 1px solid ${C_RULE}; }
.masthead {
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    font-size: 13px; letter-spacing: 0.16em; text-transform: uppercase;
    margin-bottom: 32px; display: flex; align-items: center; line-height: 1;
}
.masthead .brand { font-weight: 700; color: ${C_GS_GREEN}; }
.masthead .brand-secondary { font-weight: 400; color: ${C_INK_SOFT}; margin-left: 0.55em; }
.hero h1 {
    font-size: 64px; line-height: 1.05; font-weight: 500;
    letter-spacing: -0.02em; margin: 0 0 12px; color: ${C_INK};
}
.hero .trip-subtitle {
    font-size: 28px; line-height: 1.2; font-weight: 400;
    color: ${C_NAVY}; margin-bottom: 18px; letter-spacing: -0.01em;
}
.hero .date-line {
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    font-size: 13px; color: ${C_INK_SOFT}; letter-spacing: 0.04em;
}
.hero .date-line .sep { margin: 0 10px; color: ${C_INK_FAINT}; }
.stat-slab {
    display: flex; flex-wrap: wrap; gap: 20px; margin: 48px 0 64px;
    padding: 32px 0; border-top: 1px solid ${C_RULE}; border-bottom: 1px solid ${C_RULE};
}
.stat-slab .stat { flex: 1 1 0; min-width: 140px; }
.stat-slab .stat-number {
    font-size: 44px; line-height: 1; font-weight: 500; color: ${C_INK}; margin-bottom: 8px;
    font-feature-settings: "lnum","tnum","kern";
}
.stat-slab .stat-label {
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    font-size: 11px; font-weight: 600; letter-spacing: 0.14em;
    text-transform: uppercase; color: ${C_INK_SOFT};
}
section { margin: 80px 0; }
.section-kicker {
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    font-size: 11px; font-weight: 600; letter-spacing: 0.18em;
    text-transform: uppercase; color: ${C_GS_GREEN}; margin-bottom: 12px;
}
.section-title {
    font-size: 32px; font-weight: 500; letter-spacing: -0.01em;
    color: ${C_INK}; margin: 0 0 24px; line-height: 1.15;
}
.section-headline {
    font-size: 36px; font-weight: 500; letter-spacing: -0.01em;
    color: ${C_GS_GREEN}; margin: 0 0 28px; line-height: 1.1;
}
.section-headline.with-subtitle { margin-bottom: 8px; }
.section-subtitle {
    font-family: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
    font-size: 18px; font-style: italic; color: ${C_INK_SOFT}; margin: 0 0 32px;
}
.prose p { margin: 0 0 1em; }
.prose strong { color: ${C_INK}; font-weight: 600; }
.marquee-find { margin: 32px 0 40px; padding: 32px 0; border-top: 2px solid ${C_INK}; border-bottom: 1px solid ${C_RULE}; }
.marquee-find .gc-code { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 14px; color: ${C_NAVY}; letter-spacing: 0.04em; margin-bottom: 8px; }
.marquee-find .cache-name { font-size: 36px; line-height: 1.1; font-weight: 500; color: ${C_INK}; margin: 0 0 16px; }
.marquee-find .meta { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 13px; color: ${C_INK_SOFT}; margin-bottom: 16px; }
.marquee-find .pull { font-size: 20px; line-height: 1.5; color: ${C_INK}; max-width: 640px; font-style: italic; }
.featured-group { margin: 40px 0; }
.featured-group .group-title {
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    font-size: 11px; font-weight: 600; letter-spacing: 0.18em;
    text-transform: uppercase; color: ${C_INK_SOFT};
    margin: 0 0 16px; padding-bottom: 8px; border-bottom: 1px solid ${C_RULE};
}
.featured-cards { font-size: 0; line-height: 0; }
.featured-card {
    display: inline-block; width: 47%; margin-right: 6%; margin-bottom: 24px;
    padding: 4px 0 8px; vertical-align: top; font-size: 14px; line-height: 1.4;
}
.featured-card:nth-child(2n) { margin-right: 0; }
@media (max-width: 720px) { .featured-card { width: 100%; margin-right: 0; } }
.featured-card .gc-code { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 12px; color: ${C_NAVY}; }
.featured-card .cache-name { font-size: 18px; font-weight: 500; color: ${C_INK}; margin: 4px 0 6px; }
.featured-card .meta { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 12px; color: ${C_INK_SOFT}; }
.featured-card .why { font-size: 14px; font-style: italic; color: ${C_INK}; margin-top: 6px; }
.notable-block { margin: 28px 0 36px; }
.notable-title {
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    font-size: 13px; font-weight: 600; letter-spacing: 0.14em;
    text-transform: uppercase; color: ${C_GS_GREEN};
    margin: 0 0 14px; padding-bottom: 8px; border-bottom: 1px solid ${C_RULE};
}
.notable-list { width: 100%; border-collapse: collapse; font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 13px; }
.notable-list td { padding: 7px 14px 7px 0; vertical-align: top; border-bottom: 1px solid #ececea; }
.notable-list tr:last-child td { border-bottom: none; }
.notable-list td.code { font-family: 'SF Mono', Menlo, Consolas, monospace; color: ${C_NAVY}; white-space: nowrap; width: 80px; }
.notable-list td.name { color: ${C_INK}; font-weight: 500; }
.notable-list td.fp { color: ${C_INK_SOFT}; text-align: right; white-space: nowrap; width: 80px; }
.notable-list td.fp-lead { color: ${C_NAVY}; font-weight: 600; white-space: nowrap; width: 90px; }
.notable-list td.state { color: ${C_NAVY}; font-weight: 600; white-space: nowrap; width: 130px; }
.chart-block { margin: 32px 0; }
.chart-block .chart-title {
    font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
    font-size: 11px; font-weight: 600; letter-spacing: 0.14em;
    text-transform: uppercase; color: ${C_INK_SOFT}; margin-bottom: 16px;
}
.chart-block svg { display: block; width: 100%; height: auto; max-width: 880px; }
.chart-legend { display: flex; gap: 24px; font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 12px; color: ${C_INK_SOFT}; margin-top: 12px; flex-wrap: wrap; }
.counties-state { margin: 24px 0; padding: 16px 0; border-bottom: 1px solid ${C_RULE}; }
.counties-state:last-child { border-bottom: none; }
.counties-state-name { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: ${C_NAVY}; margin-bottom: 8px; }
.counties-state-counts { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 12px; color: ${C_INK_FAINT}; margin-bottom: 10px; }
.county-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.county-pill { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; }
.county-pill.new { background: ${C_GS_GREEN_S}; color: ${C_NAVY_DEEP}; font-weight: 500; }
.county-pill.returning { background: transparent; color: ${C_INK_SOFT}; border: 1px solid ${C_RULE}; }
.companion-block { background: ${C_BG_PANEL}; padding: 32px 36px; margin: 24px 0; border-radius: 4px; }
.companion-block .name { font-size: 24px; font-weight: 500; color: ${C_INK}; margin: 0 0 8px; }
.companion-block .stats { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 14px; color: ${C_INK_SOFT}; line-height: 1.7; }
.companion-block .stats strong { color: ${C_INK}; font-weight: 600; }
.companion-block .note { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 12px; color: ${C_INK_FAINT}; margin-top: 16px; font-style: italic; }
.shout-out { margin: 64px 0; }
.shout-out-label { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: ${C_GS_GREEN}; margin: 0 0 16px; }
.shout-bubble { background: white; border: 1px solid ${C_RULE}; border-radius: 14px; padding: 18px 22px; margin-bottom: 14px; }
.shout-bubble:last-child { margin-bottom: 0; }
.shout-bubble .bubble-label { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 10px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: ${C_INK_FAINT}; margin-bottom: 10px; }
.shout-bubble .post { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 15px; line-height: 1.5; color: ${C_INK}; }
.shout-bubble .char-count { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 11px; color: ${C_INK_FAINT}; margin-top: 8px; }
.narrative { margin: 64px 0; max-width: 640px; font-size: 18px; line-height: 1.7; color: ${C_INK}; white-space: pre-wrap; }
footer { margin-top: 96px; padding-top: 24px; border-top: 1px solid ${C_RULE}; font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 12px; color: ${C_INK_FAINT}; line-height: 1.7; }
footer .credit { margin-top: 12px; font-size: 11px; font-style: italic; color: ${C_INK_FAINT}; }
@media print {
    body { background: white; }
    .page { padding: 24px; max-width: none; }
    section { margin: 48px 0; page-break-inside: avoid; }
    .marquee-find, .companion-block { page-break-inside: avoid; }
}
`;

// ============================================================================
// String helpers
// ============================================================================

function esc(s: string | number | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(d: Date): string {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2,'0')}, ${d.getUTCFullYear()}`;
}

function formatInt(n: number): string {
  return n.toLocaleString('en-US');
}

function formatMiles(miles: number): string {
  const n = miles === Math.floor(miles) ? Math.floor(miles) : miles;
  return Number(n).toLocaleString('en-US');
}

function formatHoursHalf(hours: number): string {
  const rounded = Math.round(hours * 2) / 2;
  return rounded === Math.floor(rounded) ? String(Math.floor(rounded)) : rounded.toFixed(1);
}

// ============================================================================
// Section renderers
// ============================================================================

function renderHero(
  tripInput: TripInput,
  ownerName: string,
  companionNames: string[],
): string {
  const tripName = tripInput.tripName ?? 'Trip Report';
  const start = new Date(tripInput.startDate + 'T00:00:00Z');
  const end   = new Date(tripInput.endDate   + 'T00:00:00Z');

  const allPlayers = [ownerName, ...companionNames];
  let playersLine: string;
  if (allPlayers.length === 1) {
    playersLine = esc(allPlayers[0]);
  } else if (allPlayers.length === 2) {
    playersLine = `${esc(allPlayers[0])} <span style="color:${C_INK_FAINT};font-weight:400;">&amp;</span> ${esc(allPlayers[1])}`;
  } else {
    playersLine = allPlayers.slice(0, -1).map(esc).join(', ') + ` &amp; ${esc(allPlayers[allPlayers.length - 1])}`;
  }

  const dateRange = `${formatDate(start)} – ${formatDate(end)}`;
  const dateParts: string[] = [esc(dateRange)];
  const dist = tripInput.distance;
  if (dist?.miles) dateParts.push(`${formatMiles(dist.miles)} miles`);
  if (dist?.hours) dateParts.push(`${formatHoursHalf(dist.hours)} hours drive time`);
  const dateline = dateParts.join('<span class="sep">·</span>');

  return `
<header class="hero">
  <div class="masthead">
    <span class="masthead-mark"></span>
    <span class="brand">Routesmith</span>
    <span class="brand-secondary">Report</span>
  </div>
  <h1>${playersLine}</h1>
  <div class="trip-subtitle">${esc(tripName)}</div>
  <div class="date-line">${dateline}</div>
</header>`;
}

function renderStatSlab(ownerStats: PlayerStats, hasCounty: boolean, hasFp: boolean): string {
  const agg = ownerStats.aggregate;
  const days = ownerStats.byDay.length || 1;
  const stats: Array<[string, string]> = [
    [formatInt(agg.findsCount), 'Caches Found'],
    [String(days), 'Days on Trip'],
  ];
  if (hasCounty) stats.push([formatInt(agg.newCounties), 'New Counties']);
  if (hasFp)     stats.push([formatInt(agg.favoritePointsEarned), 'Cumulative FP']);

  const cells = stats.map(([num, label]) =>
    `<div class="stat"><div class="stat-number">${num}</div><div class="stat-label">${label}</div></div>`
  ).join('\n');

  return `<div class="stat-slab">${cells}</div>`;
}

function renderSummary(
  tripInput: TripInput,
  ownerStats: PlayerStats,
  ruleResults: RuleResult[],
  hasCounty: boolean,
  hasFp: boolean,
): string {
  const agg = ownerStats.aggregate;
  const days = ownerStats.byDay.length || 1;
  const tripName = tripInput.tripName ?? 'The trip';

  const opening = hasCounty
    ? `<strong>${esc(tripName)}</strong> ran ${days} day${days !== 1 ? 's' : ''} and produced <strong>${agg.findsCount} finds</strong> across ${agg.distinctCounties} counties in ${agg.distinctStates} state${agg.distinctStates !== 1 ? 's' : ''}.`
    : `<strong>${esc(tripName)}</strong> ran ${days} day${days !== 1 ? 's' : ''} and produced <strong>${agg.findsCount} finds</strong> across ${agg.distinctStates} state${agg.distinctStates !== 1 ? 's' : ''}.`;

  let marqueeText = '';
  for (const rr of ruleResults) {
    if (rr.rule.severity === 'marquee' && rr.matches.length > 0) {
      const wpt = rr.matches[0].waypoint;
      marqueeText = ` The headline find: <strong>${esc(wpt.gcCode)} (${esc(wpt.name)})</strong> — ${esc(rr.matches[0].note || rr.rule.description)}`;
      break;
    }
  }

  const territoryParts: string[] = [];
  if (hasCounty && agg.newCounties) territoryParts.push(`${agg.newCounties} new count${agg.newCounties === 1 ? 'y' : 'ies'}`);
  if (agg.newStates)   territoryParts.push(`${agg.newStates} new state${agg.newStates !== 1 ? 's' : ''}`);
  if (agg.newCountries) territoryParts.push(`${agg.newCountries} new countr${agg.newCountries !== 1 ? 'ies' : 'y'}`);
  const territoryText = territoryParts.length
    ? ` New territory along the way: ${territoryParts.join(', ')}.`
    : '';

  const fpText = hasFp && agg.favoritePointsEarned
    ? ` The trip caches carry a cumulative <strong>${formatInt(agg.favoritePointsEarned)} favorite points</strong>.`
    : '';

  return `
<section class="summary-section">
  <div class="section-kicker">Summary</div>
  <div class="prose col">
    <p>${opening}${marqueeText}${territoryText}${fpText}</p>
  </div>
</section>`;
}

function renderArcChartSection(ownerStats: PlayerStats, marqueeMatch: RuleMatch | null): string {
  if (!ownerStats.byDay.length) return '';
  const marqueeDay = marqueeMatch?.waypoint.findDate ?? null;
  const marqueeLabel = marqueeMatch?.waypoint.name ?? '';
  const svg = chartCumulativeFinds(ownerStats.byDay, marqueeDay, marqueeLabel);
  return `
<section>
  <div class="chart-block">
    <div class="chart-title">Cumulative Finds</div>
    ${svg}
  </div>
</section>`;
}

function renderMarqueeFinds(ruleResults: RuleResult[]): string {
  const marqueeItems: Array<{ rule: typeof ruleResults[0]['rule']; match: RuleMatch }> = [];
  for (const rr of ruleResults) {
    if (rr.rule.severity === 'marquee') {
      for (const m of rr.matches) marqueeItems.push({ rule: rr.rule, match: m });
    }
  }
  if (!marqueeItems.length) return '';

  const cards = marqueeItems.map(({ rule, match }) => {
    const wpt = match.waypoint;
    const metaParts: string[] = [];
    if (wpt.cacheType) metaParts.push(esc(wpt.cacheType));
    if (wpt.difficulty && wpt.terrain) metaParts.push(`D${wpt.difficulty}/T${wpt.terrain}`);
    if (wpt.favoritePoints) metaParts.push(`${formatInt(wpt.favoritePoints)} FP`);

    return `
<div class="marquee-find">
  <div class="gc-code">${esc(wpt.gcCode)}</div>
  <div class="cache-name">${esc(wpt.name)}</div>
  <div class="meta">${metaParts.join(' · ')}</div>
  <div class="pull">${esc(match.note || rule.description)}</div>
</div>`;
  }).join('\n');

  return `
<section>
  <h2 class="section-headline">Found It!!</h2>
  <div class="marquee-finds">${cards}</div>
</section>`;
}

function renderFeaturedFinds(ruleResults: RuleResult[], hasFp: boolean): string {
  const featured = ruleResults.filter(rr => rr.rule.severity === 'featured' && rr.matches.length > 0);
  if (!featured.length) return '';

  const groups = featured.map(rr => {
    const cards = rr.matches.map(m => {
      const wpt = m.waypoint;
      const metaParts: string[] = [];
      if (wpt.cacheType) metaParts.push(esc(wpt.cacheType));
      if (wpt.difficulty && wpt.terrain) metaParts.push(`D${wpt.difficulty}/T${wpt.terrain}`);
      if (hasFp && wpt.favoritePoints) metaParts.push(`${formatInt(wpt.favoritePoints)} FP`);
      return `
<div class="featured-card">
  <div class="gc-code">${esc(wpt.gcCode)}</div>
  <div class="cache-name">${esc(wpt.name)}</div>
  <div class="meta">${metaParts.join(' · ')}</div>
  <div class="why">${esc(m.note || rr.rule.description)}</div>
</div>`;
    }).join('\n');

    return `
<div class="featured-group">
  <div class="group-title">${esc(rr.rule.displayName)}</div>
  <div class="featured-cards">${cards}</div>
</div>`;
  }).join('\n');

  return `
<section>
  <h2 class="section-headline">Notable Finds</h2>
  ${groups}
</section>`;
}

function renderDailyRhythm(
  allPlayers: PlayerStats[],
  ownerTripFinds: Waypoint[],
  marqueeCodes: Set<string>,
  hasFp: boolean,
): string {
  const players = allPlayers.filter(p => p.byDay.length > 0);
  if (!players.length) return '';

  // FP outlier callout: for days where FP spike aligns with a marquee find
  const annotations = new Map<number, string>();
  const ownerDays = players[0].byDay;
  for (let i = 0; i < ownerDays.length; i++) {
    const ds = ownerDays[i];
    const dayStr = ds.dayDate.toISOString().slice(0, 10);
    const dayMarqueeFind = ownerTripFinds.find(w =>
      w.findDate?.toISOString().slice(0, 10) === dayStr &&
      marqueeCodes.has(w.gcCode)
    );
    if (dayMarqueeFind) annotations.set(i, dayMarqueeFind.name);
  }

  const svg = chartDailyRhythm(players, annotations, 720, 280, hasFp);
  const legend = dailyRhythmLegend(players, hasFp);

  return `
<section>
  <h2 class="section-headline">Day by Day</h2>
  <div class="chart-block">
    ${svg}
    ${legend}
  </div>
</section>`;
}

function renderCountiesSection(countiesData: CountiesData): string {
  // Group by state
  const byState = new Map<string, { newList: string[]; returnList: string[] }>();

  for (const key of countiesData.firstTime) {
    const [county, state] = key.split('|');
    if (!byState.has(state)) byState.set(state, { newList: [], returnList: [] });
    byState.get(state)!.newList.push(county);
  }
  for (const key of countiesData.previouslyFound) {
    const [county, state] = key.split('|');
    if (!byState.has(state)) byState.set(state, { newList: [], returnList: [] });
    byState.get(state)!.returnList.push(county);
  }

  if (!byState.size) return '';

  const chartSvg = chartCountiesByState(countiesData);

  const stateBlocks = [...byState.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([state, { newList, returnList }]) => {
    const total = newList.length + returnList.length;
    const stateTotals = countiesData.stateCoverage[state];
    const countStr = stateTotals?.total
      ? `${total} of ${stateTotals.total} counties`
      : `${total} countr${total !== 1 ? 'ies' : 'y'}`;

    const newPills = [...newList].sort().map(c => `<span class="county-pill new">${esc(c)}</span>`).join('');
    const retPills = [...returnList].sort().map(c => `<span class="county-pill returning">${esc(c)}</span>`).join('');

    return `
<div class="counties-state">
  <div class="counties-state-name">${esc(state)}</div>
  <div class="counties-state-counts">${countStr}</div>
  <div class="county-pills">${newPills}${retPills}</div>
</div>`;
  }).join('\n');

  return `
<section>
  <h2 class="section-headline">Counties Visited</h2>
  <div class="chart-block">${chartSvg}</div>
  ${stateBlocks}
</section>`;
}

function renderJasmerSection(
  jasmerGridState: Map<string, JasmerCellState>,
  tripYear: number,
): string {
  const hasDuring = [...jasmerGridState.values()].some(s => s === 'filled_during');
  if (!hasDuring) return '';

  const svg = chartJasmerGrid(jasmerGridState, tripYear);
  return `
<section>
  <h2 class="section-headline">Jasmer Grid</h2>
  <div class="chart-block">${svg}</div>
</section>`;
}

function renderCacheTypeBreakdown(ownerStats: PlayerStats): string {
  if (!Object.keys(ownerStats.aggregate.byCacheType).length) return '';
  const svg = chartCacheTypes(ownerStats.aggregate.byCacheType);
  return `
<section>
  <h2 class="section-headline">By Cache Type</h2>
  <div class="chart-block">${svg}</div>
</section>`;
}

function renderGroupSection(allPlayers: PlayerStats[], ownerPlayerId: string): string {
  const companions = allPlayers.filter(p => p.playerId !== ownerPlayerId);
  if (!companions.length) return '';

  const blocks = companions.map(p => {
    const agg = p.aggregate;
    const statLines: string[] = [
      `<strong>${formatInt(agg.findsCount)}</strong> finds`,
    ];
    if (agg.newCounties) statLines.push(`<strong>${formatInt(agg.newCounties)}</strong> new counties`);
    if (agg.newStates)   statLines.push(`<strong>${formatInt(agg.newStates)}</strong> new states`);
    if (agg.favoritePointsEarned) statLines.push(`<strong>${formatInt(agg.favoritePointsEarned)}</strong> FP earned`);

    const note = p.byDay.length === 0
      ? '<div class="note">Per-day stats not available (snapshot mode).</div>'
      : '';

    return `
<div class="companion-block">
  <div class="name">${esc(p.displayName)}</div>
  <div class="stats">${statLines.join(' · ')}</div>
  ${note}
</div>`;
  }).join('\n');

  return `
<section>
  <h2 class="section-headline">The Group</h2>
  ${blocks}
</section>`;
}

function renderNarrative(tripInput: TripInput): string {
  const notes = tripInput.userNotes;
  if (!notes) return '';
  return `
<section>
  <h2 class="section-headline">Notes from the Road</h2>
  <div class="narrative">${esc(notes)}</div>
</section>`;
}

function buildSocialPost(
  ownerStats: PlayerStats,
  tripInput: TripInput,
  ruleResults: RuleResult[],
): string {
  const finds = ownerStats.aggregate.findsCount;
  const days  = ownerStats.byDay.length || 1;
  const fps   = ownerStats.aggregate.favoritePointsEarned;
  const newC  = ownerStats.aggregate.newCounties;
  const newS  = ownerStats.aggregate.newStates;

  const marqueeMatches: Array<{ rule: RuleResult['rule']; match: RuleMatch }> = [];
  for (const rr of ruleResults) {
    if (rr.rule.severity === 'marquee') {
      for (const m of rr.matches) marqueeMatches.push({ rule: rr.rule, match: m });
    }
  }

  const parts = [`Finished ${tripInput.tripName ?? 'a geocaching trip'} — ${finds} caches in ${days} day${days !== 1 ? 's' : ''}.`];
  if (marqueeMatches.length > 0) {
    const wpt = marqueeMatches[0].match.waypoint;
    parts.push(`Highlight: ${wpt.gcCode} ${wpt.name}.`);
  }
  const extras: string[] = [];
  if (newC) extras.push(`${newC} new count${newC !== 1 ? 'ies' : 'y'}`);
  if (newS) extras.push(`${newS} new state${newS !== 1 ? 's' : ''}`);
  if (fps)  extras.push(`${formatInt(fps)} cumulative FPs`);
  if (extras.length) parts.push(extras.join(', ') + '.');
  parts.push('#geocaching');

  let post = parts.join(' ');
  if (post.length > 280) post = post.slice(0, 277) + '...';
  return post;
}

function buildMediumSocialPost(
  ownerStats: PlayerStats,
  tripInput: TripInput,
  ruleResults: RuleResult[],
  countiesData: CountiesData,
): string {
  const finds = ownerStats.aggregate.findsCount;
  const days  = ownerStats.byDay.length || 1;
  const newC  = ownerStats.aggregate.newCounties;
  const newS  = ownerStats.aggregate.newStates;
  const dist  = tripInput.distance;

  const milesText = dist?.miles ? `${formatMiles(dist.miles)} miles, ` : '';

  const statesSet = new Set<string>();
  for (const key of [...countiesData.firstTime, ...countiesData.previouslyFound]) {
    const state = key.split('|')[1];
    if (state) statesSet.add(state);
  }
  const statesAbbrev = [...statesSet].sort().map(s => STATE_ABBREVIATIONS[s] ?? s).join('/');
  const statesText = statesAbbrev ? ` across ${statesAbbrev}` : '';

  const marqueeMatches: Array<{ rule: RuleResult['rule']; match: RuleMatch }> = [];
  const rareMatches: RuleMatch[] = [];
  for (const rr of ruleResults) {
    if (rr.rule.severity !== 'marquee') continue;
    for (const m of rr.matches) {
      if (rr.rule.id === 'rare_cache_type') rareMatches.push(m);
      else marqueeMatches.push({ rule: rr.rule, match: m });
    }
  }

  let marqueeText = '';
  if (marqueeMatches.length > 0) {
    const { rule, match } = marqueeMatches[0];
    const wpt = match.waypoint;
    const notePart = (match.note || rule.description).split('.')[0].toLowerCase();
    const fpPart = wpt.favoritePoints ? ` (${formatInt(wpt.favoritePoints)} FP)` : '';
    marqueeText = ` Headline: ${wpt.gcCode} ${wpt.name}${fpPart}, ${notePart}.`;
  }

  let rareText = '';
  if (rareMatches.length > 0) {
    const types = [...new Set(rareMatches.map(m => m.waypoint.cacheType).filter(Boolean))] as string[];
    if (types.length === 1) rareText = ` Plus a ${types[0]}.`;
    else if (types.length === 2) rareText = ` Plus a ${types[0]} and a ${types[1]}.`;
    else rareText = ` Plus ${types.slice(0, -1).join(', ')}, and a ${types[types.length - 1]}.`;
  }

  const territoryBits: string[] = [];
  if (newC) territoryBits.push(`${newC} new counties`);
  if (newS) territoryBits.push(`${newS} new state${newS !== 1 ? 's' : ''}`);
  const territoryText = territoryBits.length ? ' ' + territoryBits.join(', ') + '.' : '';

  const hashBase = (tripInput.tripName ?? '').replace(/[^a-zA-Z0-9]/g, '');
  const tripHashtag = hashBase ? ` #${hashBase}` : '';

  return `${days} days, ${milesText}${finds} caches${statesText} for ${tripInput.tripName ?? 'the trip'}.${marqueeText}${rareText}${territoryText} #geocaching${tripHashtag}`;
}

function renderSocialCard(shortPost: string, mediumPost: string): string {
  return `
<div class="shout-out">
  <div class="shout-out-label">Shout Out!</div>
  <div class="shout-bubble">
    <div class="bubble-label">Quick post</div>
    <div class="post">${esc(shortPost)}</div>
    <div class="char-count">${shortPost.length} characters</div>
  </div>
  <div class="shout-bubble">
    <div class="bubble-label">With context · fits Bluesky &amp; Mastodon</div>
    <div class="post">${esc(mediumPost)}</div>
    <div class="char-count">${mediumPost.length} characters</div>
  </div>
</div>`;
}

function renderFooter(): string {
  const now = new Date();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dateStr = `${months[now.getMonth()]} ${String(now.getDate()).padStart(2,'0')}, ${now.getFullYear()}`;
  return `
<footer>
  <div>Generated ${dateStr} · v1.0</div>
  <div class="credit">Geocaching.com cache icons © Groundspeak, Inc. DBA Geocaching. Used with permission.</div>
</footer>`;
}

// ============================================================================
// Top-level render function
// ============================================================================

export interface RenderOptions {
  tripInput: TripInput;
  ownerStats: PlayerStats;
  allPlayerStats: PlayerStats[];
  ruleResults: RuleResult[];
  countiesData: CountiesData;
  jasmerGridState: Map<string, JasmerCellState>;
  ownerTripFinds: Waypoint[];
  fieldAvailability: FieldAvailability;
}

/**
 * Render the complete HTML report string.
 * Python reference: render_report()
 */
export function renderReport(opts: RenderOptions): string {
  const {
    tripInput,
    ownerStats,
    allPlayerStats,
    ruleResults,
    countiesData,
    jasmerGridState,
    ownerTripFinds,
    fieldAvailability: { hasCounty, hasFp },
  } = opts;

  const companionNames = allPlayerStats
    .filter(p => p.playerId !== ownerStats.playerId)
    .map(p => p.displayName);

  const marqueeCodes = new Set<string>();
  for (const rr of ruleResults) {
    if (rr.rule.severity === 'marquee') {
      for (const m of rr.matches) marqueeCodes.add(m.waypoint.gcCode);
    }
  }

  let marqueeMatch: RuleMatch | null = null;
  for (const rr of ruleResults) {
    if (rr.rule.severity === 'marquee' && rr.matches.length > 0) {
      marqueeMatch = rr.matches[0];
      break;
    }
  }

  const tripYear = new Date(tripInput.startDate + 'T00:00:00Z').getUTCFullYear();
  const shortPost  = buildSocialPost(ownerStats, tripInput, ruleResults);
  const mediumPost = buildMediumSocialPost(ownerStats, tripInput, ruleResults, countiesData);

  const pieces: string[] = [
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(tripInput.tripName ?? 'Trip Report')}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">`,
    renderHero(tripInput, ownerStats.displayName, companionNames),
    renderStatSlab(ownerStats, hasCounty, hasFp),
    renderSummary(tripInput, ownerStats, ruleResults, hasCounty, hasFp),
    renderArcChartSection(ownerStats, marqueeMatch),
    renderMarqueeFinds(ruleResults),
    renderFeaturedFinds(ruleResults, hasFp),
    renderDailyRhythm(allPlayerStats, ownerTripFinds, marqueeCodes, hasFp),
    hasCounty ? renderCountiesSection(countiesData) : '',
    renderJasmerSection(jasmerGridState, tripYear),
    renderCacheTypeBreakdown(ownerStats),
    renderGroupSection(allPlayerStats, ownerStats.playerId),
    renderNarrative(tripInput),
    renderSocialCard(shortPost, mediumPost),
    renderFooter(),
    '</div>\n</body>\n</html>',
  ];

  return pieces.join('\n');
}
