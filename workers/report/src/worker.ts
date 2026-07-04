/**
 * worker.ts — Cloudflare Worker entry point for the Routesmith REPORT Worker.
 *
 * Routes:
 *   GET  /api/report/health  — Health check (no auth required)
 *   POST /api/report/run     — Run pipeline, return HTML report
 *   POST /api/report/data    — Run pipeline, return JSON dashboard data
 *
 * Environment bindings (wrangler.toml):
 *   REPORT_BUCKET    — R2 bucket for GPX files and reference lists
 *   DB               — D1 database
 *   CLERK_SECRET_KEY — Clerk secret key (set via wrangler secret put)
 */

import { runPipeline, type GpxSources } from './pipeline.js';
import { fetchReferenceListsFromR2 } from './referenceLists.js';
import { renderReport } from './renderer.js';
import { requireAuth, unauthorizedResponse, AuthError } from './auth.js';
import { handleAccountSync, handleAccountMe, handleGpxFiles } from './account.js';
import { handlePresign, handleUploadData, handleConfirm, handleJobStatus } from './upload.js';
import { handleReportRunFromR2, handleReportStatus } from './reportRun.js';
import type { TripInput } from './types.js';

// ============================================================================
// Environment type — imported from types.ts (single source of truth)
// ============================================================================

export type { Env } from './types.js';
import type { Env } from './types.js';

// ============================================================================
// Request routing
// ============================================================================

// ============================================================================
// CORS
// ============================================================================

const ALLOWED_ORIGINS = new Set([
  'https://routesmithing.com',
  'https://www.routesmithing.com',
  'http://localhost:8788',   // wrangler pages dev
  'http://localhost:3000',
]);

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://routesmithing.com';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function addCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) {
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight for all routes
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Health check — no auth required
    if (url.pathname === '/api/report/health') {
      return addCors(new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      }), request);
    }

    // All other routes require authentication
    let user;
    try {
      user = await requireAuth(request);
    } catch (e) {
      if (e instanceof AuthError) return addCors(unauthorizedResponse(e.message), request);
      return addCors(unauthorizedResponse('Authentication failed'), request);
    }

    // Report run routes
    if (url.pathname === '/api/report/run-from-r2' && request.method === 'POST') {
      return addCors(await handleReportRunFromR2(request, user, env), request);
    }

    const reportStatusMatch = url.pathname.match(/^\/api\/report\/status\/([\w-]+)$/);
    if (reportStatusMatch && request.method === 'GET') {
      return addCors(await handleReportStatus(reportStatusMatch[1], user, env), request);
    }

    // Upload routes
    if (url.pathname === '/api/upload/presign' && request.method === 'POST') {
      return addCors(await handlePresign(request, user, env), request);
    }

    const uploadDataMatch = url.pathname.match(/^\/api\/upload\/data\/([\w-]+)$/);
    if (uploadDataMatch && request.method === 'PUT') {
      return addCors(await handleUploadData(request, user, env, uploadDataMatch[1]), request);
    }

    const confirmMatch = url.pathname.match(/^\/api\/upload\/confirm\/([\w-]+)$/);
    if (confirmMatch && request.method === 'POST') {
      return addCors(await handleConfirm(request, user, env, confirmMatch[1]), request);
    }

    const statusMatch = url.pathname.match(/^\/api\/upload\/status\/([\w-]+)$/);
    if (statusMatch && request.method === 'GET') {
      return addCors(await handleJobStatus(statusMatch[1], user, env), request);
    }

    // Account routes
    if (url.pathname === '/api/account/sync' && request.method === 'POST') {
      return addCors(await handleAccountSync(user, env), request);
    }

    if (url.pathname === '/api/account/me' && request.method === 'GET') {
      return addCors(await handleAccountMe(user, env), request);
    }

    if (url.pathname === '/api/account/gpx-files' && request.method === 'GET') {
      return addCors(await handleGpxFiles(user, env), request);
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (url.pathname === '/api/report/run') {
      return addCors(await handleReportRun(request, env, user, 'html'), request);
    }

    if (url.pathname === '/api/report/data') {
      return addCors(await handleReportRun(request, env, user, 'json'), request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ============================================================================
// Report run handler
// ============================================================================

async function handleReportRun(
  request: Request,
  env: Env,
  user: { userId: string; email: string; displayName: string },
  format: 'html' | 'json',
): Promise<Response> {
  let body: {
    tripInput: TripInput;
    gpxSources: GpxSources;
  };

  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body', 400);
  }

  if (!body.tripInput?.startDate || !body.tripInput?.endDate || !body.tripInput?.owner) {
    return jsonError('tripInput must include startDate, endDate, and owner', 400);
  }

  // Load reference lists from R2
  let refLists;
  try {
    refLists = await fetchReferenceListsFromR2(env.REPORT_BUCKET as Parameters<typeof fetchReferenceListsFromR2>[0]);
  } catch (e) {
    return jsonError(`Failed to load reference lists: ${(e as Error).message}`, 500);
  }

  // Run pipeline
  let result;
  try {
    result = await runPipeline(body.tripInput, body.gpxSources, refLists);
  } catch (e) {
    return jsonError(`Pipeline error: ${(e as Error).message}`, 500);
  }

  if (format === 'json') {
    return new Response(
      JSON.stringify({
        user: { userId: user.userId, email: user.email, displayName: user.displayName },
        ownerStats: serializePlayerStats(result.ownerStats),
        allPlayerStats: result.allPlayerStats.map(serializePlayerStats),
        ruleResults: result.ruleResults.map(rr => ({
          rule: {
            id: rr.rule.id,
            displayName: rr.rule.displayName,
            description: rr.rule.description,
            severity: rr.rule.severity,
          },
          matches: rr.matches.map(m => ({
            waypoint: serializeWaypoint(m.waypoint),
            note: m.note,
          })),
        })),
        countiesData: {
          firstTime: [...result.countiesData.firstTime],
          previouslyFound: [...result.countiesData.previouslyFound],
          stateCoverage: result.countiesData.stateCoverage,
        },
        jasmerGridState: Object.fromEntries(result.jasmerGridState),
        fieldAvailability: result.fieldAvailability,
        warnings: result.warnings,
        diagnostics: result.diagnostics,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Render HTML report
  const html = renderReport({
    tripInput: result.tripInput,
    ownerStats: result.ownerStats,
    allPlayerStats: result.allPlayerStats,
    ruleResults: result.ruleResults,
    countiesData: result.countiesData,
    jasmerGridState: result.jasmerGridState,
    ownerTripFinds: [],
    fieldAvailability: result.fieldAvailability,
  });

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ============================================================================
// Serialization helpers
// ============================================================================

function serializePlayerStats(p: import('./types.js').PlayerStats) {
  return {
    playerId: p.playerId,
    displayName: p.displayName,
    role: p.role,
    aggregate: p.aggregate,
    byDay: p.byDay.map(ds => ({
      dayDate: ds.dayDate.toISOString().slice(0, 10),
      finds: ds.finds,
      favoritePoints: ds.favoritePoints,
      counties: [...ds.counties],
      newCounties: ds.newCounties,
      byCacheType: ds.byCacheType,
      bestFind: ds.bestFind ? serializeWaypoint(ds.bestFind) : null,
      bestFindReason: ds.bestFindReason,
    })),
  };
}

function serializeWaypoint(w: import('./types.js').Waypoint) {
  return {
    gcCode: w.gcCode,
    name: w.name,
    cacheType: w.cacheType,
    lat: w.lat,
    lon: w.lon,
    county: w.county,
    state: w.state,
    country: w.country,
    favoritePoints: w.favoritePoints,
    difficulty: w.difficulty,
    terrain: w.terrain,
    findDate: w.findDate?.toISOString().slice(0, 10) ?? null,
    placementTime: w.placementTime?.toISOString() ?? null,
  };
}

// ============================================================================
// Error helper
// ============================================================================

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
