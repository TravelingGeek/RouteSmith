/**
 * charts.ts — SVG chart generators for the Routesmith REPORT module.
 *
 * All functions return SVG strings suitable for direct inline embedding in
 * HTML. No external dependencies. Output is semantically and visually
 * identical to the Python reference implementation.
 *
 * Python reference: report.py (chart_cumulative_finds, chart_daily_rhythm,
 * chart_counties_by_state, chart_jasmer_grid, chart_cache_types)
 */

import type { DailyStats, PlayerStats } from './types.js';
import type { JasmerCellState } from './statistics.js';

// ============================================================================
// Palette (mirrors report.py COLOR_* constants)
// ============================================================================

const C_INK        = '#1a2733';
const C_INK_SOFT   = '#475463';
const C_INK_FAINT  = '#8b95a1';
const C_NAVY       = '#1f4068';
const C_GS_GREEN   = '#01884e';
const C_GS_GREEN_S = '#a8d8b8';
const C_RULE       = '#d6dce3';
const C_PAPER      = '#fbfaf6';

const CHART_PRIMARY = C_NAVY;
const CHART_ACCENT  = C_GS_GREEN;
const CHART_MUTED   = '#cad1d9';

const PLAYER_COLORS = [
  C_NAVY,
  '#6b7a8c',
  '#8a7363',
  '#6a8a6a',
  '#7a6a8c',
  '#8c8c6b',
];

// ============================================================================
// Helpers
// ============================================================================

function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function svgText(
  x: number, y: number, text: string,
  opts: {
    size?: number;
    color?: string;
    anchor?: 'start' | 'middle' | 'end';
    weight?: number;
    family?: 'sans' | 'serif';
  } = {}
): string {
  const size   = opts.size   ?? 11;
  const color  = opts.color  ?? C_INK_SOFT;
  const anchor = opts.anchor ?? 'start';
  const weight = opts.weight ?? 400;
  const fam = opts.family === 'serif'
    ? `'Iowan Old Style', Georgia, serif`
    : `-apple-system, 'Segoe UI', system-ui, sans-serif`;
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ` +
    `text-anchor="${anchor}" font-weight="${weight}" font-family="${fam}">${esc(text)}</text>`;
}

function niceMax(v: number): number {
  if (v <= 20)   return Math.ceil(v / 5)    * 5;
  if (v <= 100)  return Math.ceil(v / 25)   * 25;
  if (v <= 1000) return Math.ceil(v / 250)  * 250;
  return Math.ceil(v / 1000) * 1000;
}

function formatDateShort(d: Date): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function formatInt(n: number): string {
  return n.toLocaleString('en-US');
}

// ============================================================================
// Cumulative finds chart
// ============================================================================

/**
 * Step-chart of cumulative finds across the trip days.
 * Python reference: chart_cumulative_finds()
 */
export function chartCumulativeFinds(
  dailyStats: DailyStats[],
  marqueeDay: Date | null = null,
  marqueeLabel: string = '',
  width = 720,
  height = 240,
): string {
  if (!dailyStats.length) return '';

  const padL = 48, padR = 24, padT = 24, padB = 56;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const n = dailyStats.length;

  // Cumulative series
  const cumulative: number[] = [];
  let running = 0;
  for (const ds of dailyStats) {
    running += ds.finds;
    cumulative.push(running);
  }

  const maxY = Math.max(...cumulative, 1);
  let yTop: number;
  if (maxY <= 50)       yTop = Math.ceil(maxY / 25) * 25;
  else if (maxY <= 200) yTop = Math.ceil(maxY / 50) * 50;
  else                  yTop = Math.ceil(maxY / 100) * 100;

  const xOf = (i: number) => padL + (i / Math.max(n - 1, 1)) * plotW;
  const yOf = (v: number) => padT + plotH - (v / yTop) * plotH;

  const areaPoints = [`M ${xOf(0)} ${yOf(0)}`,
    ...cumulative.map((c, i) => `L ${xOf(i)} ${yOf(c)}`),
    `L ${xOf(n - 1)} ${yOf(0)} Z`].join(' ');

  const lineParts = [`M ${xOf(0)} ${yOf(cumulative[0])}`,
    ...cumulative.slice(1).map((c, i) => `L ${xOf(i + 1)} ${yOf(c)}`)].join(' ');

  const els: string[] = [];

  // Grid
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * plotH;
    const val = Math.round(yTop * (1 - g / 4));
    els.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${y}" y2="${y}" stroke="${C_RULE}" stroke-width="0.5"/>`);
    els.push(svgText(padL - 8, y + 4, formatInt(val), { size: 10, anchor: 'end', color: C_INK_FAINT }));
  }

  // Area + line
  els.push(`<path d="${areaPoints}" fill="${CHART_PRIMARY}" fill-opacity="0.12"/>`);
  els.push(`<path d="${lineParts}" stroke="${CHART_PRIMARY}" stroke-width="2" fill="none"/>`);

  // Points
  for (let i = 0; i < n; i++) {
    els.push(`<circle cx="${xOf(i)}" cy="${yOf(cumulative[i])}" r="3" fill="${CHART_PRIMARY}"/>`);
  }

  // Marquee annotation
  if (marqueeDay) {
    const marqueeDayStr = marqueeDay.toISOString().slice(0, 10);
    const idx = dailyStats.findIndex(ds => ds.dayDate.toISOString().slice(0, 10) === marqueeDayStr);
    if (idx >= 0) {
      const mx = xOf(idx), my = yOf(cumulative[idx]);
      els.push(`<circle cx="${mx}" cy="${my}" r="6" fill="none" stroke="${CHART_ACCENT}" stroke-width="2"/>`);
      els.push(`<line x1="${mx}" x2="${mx}" y1="${my - 12}" y2="${my - 32}" stroke="${CHART_ACCENT}" stroke-width="1"/>`);
      const anchor: 'start' | 'middle' | 'end' =
        mx > padL + plotW - 50 ? 'end' : mx < padL + 50 ? 'start' : 'middle';
      els.push(svgText(mx, my - 38, marqueeLabel, { size: 11, color: CHART_ACCENT, anchor, weight: 600 }));
    }
  }

  // X labels
  const step = Math.max(1, Math.floor(n / 8));
  for (let i = 0; i < n; i++) {
    if (i % step === 0 || i === n - 1) {
      els.push(svgText(xOf(i), height - padB + 18, formatDateShort(dailyStats[i].dayDate),
        { size: 10, anchor: 'middle' }));
    }
  }

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">\n${els.join('\n')}\n</svg>`;
}

// ============================================================================
// Daily rhythm chart (multi-player grouped bars + FP line)
// ============================================================================

/**
 * Multi-player grouped bar chart with FP line on secondary axis.
 * Python reference: chart_daily_rhythm()
 */
export function chartDailyRhythm(
  allPlayers: PlayerStats[],
  annotations: Map<number, string> = new Map(),
  width = 720,
  height = 280,
  showFpLine = true,
): string {
  const players = allPlayers.filter(p => p.byDay.length > 0);
  if (!players.length) return '';

  const days = players[0].byDay;
  const n = days.length;
  if (!n) return '';

  const padL = 48, padR = 72, padT = 48, padB = 56;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  // Per-day maxima
  const maxFindsByDay: number[] = [];
  const maxFpByDay: number[] = [];
  for (let i = 0; i < n; i++) {
    const findVals = players.filter(p => i < p.byDay.length).map(p => p.byDay[i].finds);
    const fpVals   = players.filter(p => i < p.byDay.length).map(p => p.byDay[i].favoritePoints);
    maxFindsByDay.push(findVals.length ? Math.max(...findVals) : 0);
    maxFpByDay.push(fpVals.length ? Math.max(...fpVals) : 0);
  }

  const findsTop = niceMax(Math.max(...maxFindsByDay, 1));
  const fpTop    = niceMax(Math.max(...maxFpByDay, 1));

  const groupW = plotW / n;
  const barsTotalW = groupW * 0.80;
  const barW = barsTotalW / players.length;

  const xBar    = (dayI: number, pI: number) =>
    padL + groupW * (dayI + 0.5) - barsTotalW / 2 + barW * pI;
  const xCenter = (dayI: number) => padL + groupW * (dayI + 0.5);
  const yFinds  = (v: number) => padT + plotH - (v / findsTop) * plotH;
  const yFp     = (v: number) => padT + plotH - (v / fpTop)    * plotH;

  const els: string[] = [];

  // Grid
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * plotH;
    els.push(`<line x1="${padL}" x2="${padL + plotW}" y1="${y}" y2="${y}" stroke="${C_RULE}" stroke-width="0.5"/>`);
    els.push(svgText(padL - 8, y + 4, String(Math.round(findsTop * (1 - g / 4))),
      { size: 10, anchor: 'end', color: CHART_PRIMARY }));
    if (showFpLine) {
      els.push(svgText(padL + plotW + 8, y + 4, formatInt(Math.round(fpTop * (1 - g / 4))),
        { size: 10, anchor: 'start', color: C_GS_GREEN }));
    }
  }

  // Bars
  for (let pI = 0; pI < players.length; pI++) {
    const color = PLAYER_COLORS[pI % PLAYER_COLORS.length];
    const p = players[pI];
    for (let dI = 0; dI < n; dI++) {
      if (dI >= p.byDay.length) continue;
      const ds = p.byDay[dI];
      if (ds.finds <= 0) continue;
      const x = xBar(dI, pI);
      const yTop = yFinds(ds.finds);
      const h = padT + plotH - yTop;
      els.push(`<rect x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${color}" fill-opacity="0.85"/>`);
    }
  }

  // FP line + outlier callouts
  if (showFpLine) {
    const fpPoints = maxFpByDay.map((v, i) => ({ x: xCenter(i), y: yFp(v) }));
    const pathD = fpPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    els.push(`<path d="${pathD}" stroke="${C_GS_GREEN}" stroke-width="2" fill="none"/>`);
    for (const { x, y } of fpPoints) {
      els.push(`<circle cx="${x}" cy="${y}" r="3" fill="${C_PAPER}" stroke="${C_GS_GREEN}" stroke-width="1.8"/>`);
    }

    for (const [dayI, label] of annotations) {
      if (dayI < 0 || dayI >= n) continue;
      const x = xCenter(dayI);
      const y = yFp(maxFpByDay[dayI]);
      const labelY = Math.max(y - 18, padT - 28);
      els.push(`<line x1="${x.toFixed(1)}" y1="${(labelY + 3).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(y - 4).toFixed(1)}" stroke="${C_GS_GREEN}" stroke-width="1" stroke-dasharray="2,2"/>`);
      els.push(svgText(x, labelY, label, { size: 11, anchor: 'middle', color: C_GS_GREEN, weight: 600 }));
    }
  }

  // X labels
  for (let i = 0; i < n; i++) {
    els.push(svgText(xCenter(i), height - padB + 18, formatDateShort(days[i].dayDate),
      { size: 10, anchor: 'middle' }));
  }

  // Axis labels
  els.push(svgText(padL - 8, padT - 12, 'Finds', { size: 10, anchor: 'end', color: CHART_PRIMARY }));
  if (showFpLine) {
    els.push(svgText(padL + plotW + 8, padT - 12, 'FP', { size: 10, anchor: 'start', color: C_GS_GREEN }));
  }

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">\n${els.join('\n')}\n</svg>`;
}

// ============================================================================
// Counties by state chart
// ============================================================================

/**
 * Stacked horizontal bars showing new vs. returning counties per state.
 * Python reference: chart_counties_by_state()
 */
export function chartCountiesByState(
  countiesData: {
    firstTime: Set<string>;
    previouslyFound: Set<string>;
  },
  width = 680,
  barHeight = 14,
): string {
  // Aggregate by state
  const stateNew     = new Map<string, number>();
  const stateReturn  = new Map<string, number>();

  for (const key of countiesData.firstTime) {
    const state = key.split('|')[1] ?? '';
    stateNew.set(state, (stateNew.get(state) ?? 0) + 1);
  }
  for (const key of countiesData.previouslyFound) {
    const state = key.split('|')[1] ?? '';
    stateReturn.set(state, (stateReturn.get(state) ?? 0) + 1);
  }

  const states = [...new Set([...stateNew.keys(), ...stateReturn.keys()])].sort();
  if (!states.length) return '';

  const maxTotal = Math.max(...states.map(s => (stateNew.get(s) ?? 0) + (stateReturn.get(s) ?? 0)), 1);
  const padL = 120, padR = 40, padT = 16, rowGap = 6;
  const plotW = width - padL - padR;
  const totalH = padT + states.length * (barHeight + rowGap) + 32;

  const els: string[] = [];

  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    const newN  = stateNew.get(state)    ?? 0;
    const retN  = stateReturn.get(state) ?? 0;
    const total = newN + retN;
    const y = padT + i * (barHeight + rowGap);

    const newW = (newN  / maxTotal) * plotW;
    const retW = (retN  / maxTotal) * plotW;

    // State label
    els.push(svgText(padL - 8, y + barHeight - 2, state, { size: 11, anchor: 'end', color: C_INK_SOFT }));

    // Return bar (underneath)
    if (retW > 0) {
      els.push(`<rect x="${padL}" y="${y}" width="${retW.toFixed(1)}" height="${barHeight}" fill="${CHART_MUTED}"/>`);
    }
    // New bar (on top, stacked right after return)
    if (newW > 0) {
      els.push(`<rect x="${(padL + retW).toFixed(1)}" y="${y}" width="${newW.toFixed(1)}" height="${barHeight}" fill="${CHART_ACCENT}"/>`);
    }
    // Total label
    els.push(svgText(padL + (newW + retW) + 6, y + barHeight - 2, String(total),
      { size: 10, color: C_INK_FAINT }));
  }

  // Legend
  const legY = totalH - 16;
  els.push(`<rect x="${padL}" y="${legY}" width="10" height="10" fill="${CHART_MUTED}" rx="1"/>`);
  els.push(svgText(padL + 14, legY + 9, 'Previously found', { size: 10, color: C_INK_SOFT }));
  els.push(`<rect x="${padL + 140}" y="${legY}" width="10" height="10" fill="${CHART_ACCENT}" rx="1"/>`);
  els.push(svgText(padL + 154, legY + 9, 'New this trip', { size: 10, color: C_INK_SOFT }));

  return `<svg viewBox="0 0 ${width} ${totalH}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">\n${els.join('\n')}\n</svg>`;
}

// ============================================================================
// Jasmer grid
// ============================================================================

/**
 * Year × month grid visualization.
 * Python reference: render_jasmer_grid() in report.py
 */
export function chartJasmerGrid(
  gridState: Map<string, JasmerCellState>,
  tripYear: number,
  width = 720,
): string {
  const years = [...new Set([...gridState.keys()].map(k => parseInt(k.split('|')[0])))].sort();
  if (!years.length) return '';

  const MONTHS_SHORT = ['J','F','M','A','M','J','J','A','S','O','N','D'];
  const cellW = Math.floor((width - 60) / 12);
  const cellH = 14;
  const rowGap = 2;
  const padL = 48, padT = 32;
  const totalH = padT + years.length * (cellH + rowGap) + 24;

  const els: string[] = [];

  // Month headers
  for (let m = 0; m < 12; m++) {
    els.push(svgText(padL + m * cellW + cellW / 2, padT - 8, MONTHS_SHORT[m],
      { size: 9, anchor: 'middle', color: C_INK_FAINT }));
  }

  for (let yi = 0; yi < years.length; yi++) {
    const year = years[yi];
    const y = padT + yi * (cellH + rowGap);

    // Year label
    const labelColor = year === tripYear ? C_NAVY : C_INK_FAINT;
    const labelWeight = year === tripYear ? 600 : 400;
    els.push(svgText(padL - 6, y + cellH - 2, String(year),
      { size: 9, anchor: 'end', color: labelColor, weight: labelWeight }));

    for (let m = 1; m <= 12; m++) {
      if (year === 2000 && m < 5) continue; // No caches before May 2000
      const cell = `${year}|${m}`;
      const state = gridState.get(cell) ?? 'empty';
      const x = padL + (m - 1) * cellW;

      let fill: string;
      if (state === 'filled_during') fill = CHART_ACCENT;
      else if (state === 'filled_before') fill = CHART_MUTED;
      else fill = 'none';

      const stroke = state === 'empty' ? C_RULE : 'none';
      els.push(`<rect x="${x}" y="${y}" width="${cellW - 1}" height="${cellH}" fill="${fill}" stroke="${stroke}" stroke-width="0.5" rx="1"/>`);
    }
  }

  // Legend
  const legY = totalH - 12;
  els.push(`<rect x="${padL}" y="${legY}" width="10" height="10" fill="${CHART_MUTED}" rx="1"/>`);
  els.push(svgText(padL + 14, legY + 9, 'Filled before trip', { size: 9, color: C_INK_SOFT }));
  els.push(`<rect x="${padL + 130}" y="${legY}" width="10" height="10" fill="${CHART_ACCENT}" rx="1"/>`);
  els.push(svgText(padL + 144, legY + 9, 'Filled this trip', { size: 9, color: C_INK_SOFT }));

  return `<svg viewBox="0 0 ${width} ${totalH}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">\n${els.join('\n')}\n</svg>`;
}

// ============================================================================
// Cache type breakdown chart
// ============================================================================

/**
 * Horizontal bar chart of cache types, sorted descending.
 * Python reference: chart_cache_types()
 */
export function chartCacheTypes(
  byCacheType: Record<string, number>,
  width = 520,
  barHeight = 16,
): string {
  const sorted = Object.entries(byCacheType)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);
  if (!sorted.length) return '';

  const maxVal = sorted[0][1];
  const padL = 160, padR = 48, padT = 8, rowGap = 6;
  const plotW = width - padL - padR;
  const totalH = padT + sorted.length * (barHeight + rowGap) + 8;

  const els: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const [type, count] = sorted[i];
    const y = padT + i * (barHeight + rowGap);
    const bw = (count / maxVal) * plotW;

    els.push(svgText(padL - 8, y + barHeight - 2, type,
      { size: 11, anchor: 'end', color: C_INK_SOFT }));
    els.push(`<rect x="${padL}" y="${y}" width="${bw.toFixed(1)}" height="${barHeight}" fill="${CHART_PRIMARY}" fill-opacity="0.75" rx="1"/>`);
    els.push(svgText(padL + bw + 6, y + barHeight - 2, String(count),
      { size: 10, color: C_INK_FAINT }));
  }

  return `<svg viewBox="0 0 ${width} ${totalH}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">\n${els.join('\n')}\n</svg>`;
}

// ============================================================================
// Chart legend HTML helper
// ============================================================================

/**
 * Build an HTML legend row for the daily rhythm chart player colors.
 * Returns an HTML string.
 */
export function dailyRhythmLegend(players: PlayerStats[], showFpLine: boolean): string {
  const items: string[] = [];
  for (let i = 0; i < players.length; i++) {
    const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
    items.push(
      `<span class="chart-legend-item">` +
      `<span class="swatch swatch-bar" style="background:${color};display:inline-block;width:12px;height:12px;border-radius:1px;margin-right:6px;vertical-align:middle;"></span>` +
      `${esc(players[i].displayName)}</span>`
    );
  }
  if (showFpLine) {
    items.push(
      `<span class="chart-legend-item">` +
      `<span class="swatch swatch-line" style="background:${C_GS_GREEN};display:inline-block;width:18px;height:2px;margin-right:8px;vertical-align:middle;"></span>` +
      `Max FP</span>`
    );
  }
  return `<div class="chart-legend">${items.join('\n')}</div>`;
}
