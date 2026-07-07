/**
 * worker.ts — Routesmith Admin Worker
 *
 * Handles admin operations: reference list management, user management,
 * job monitoring. All routes require Clerk JWT auth + is_admin = 1 in D1.
 *
 * Authorization: Clerk handles authentication (identity).
 *                D1 users.is_admin handles authorization (permissions).
 */

import type { Env } from './types.js';
import type { AuthUser } from './auth.js';
import { requireAuth, unauthorizedResponse } from './auth.js';
import {
  handleListReferenceLists,
  handleUploadReferenceList,
  handleDeleteReferenceList,
} from './referenceLists.js';
import { RULES } from './rules.js';

const ALLOWED_ORIGINS = [
  'https://routesmithing.com',
  'https://www.routesmithing.com',
  'http://localhost:3000',
  'http://localhost:8788',
];

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function addCors(response: Response, request: Request): Response {
  const origin = request.headers.get('Origin');
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    // Health check (no auth)
    if (url.pathname === '/api/admin/health') {
      return addCors(new Response(JSON.stringify({
        ok: true,
        worker: 'routesmith-admin',
        build: '2026.07.07.001',
        timestamp: new Date().toISOString(),
      }), { headers: { 'Content-Type': 'application/json' } }), request);
    }

    // ── Auth: verify Clerk JWT ────────────────────────────────────────────────
    let clerkUser: AuthUser;
    try {
      clerkUser = await requireAuth(request);
    } catch (e) {
      return addCors(unauthorizedResponse((e as Error).message), request);
    }

    // ── Authz: check is_admin in D1 ──────────────────────────────────────────
    const userRow = await env.DB
      .prepare(`SELECT is_admin FROM users WHERE user_id = ?`)
      .bind(clerkUser.userId)
      .first<{ is_admin: number }>();

    if (!userRow || !userRow.is_admin) {
      return addCors(jsonError('Forbidden — admin access required', 403), request);
    }

    const user = clerkUser;

    // ── Routes ────────────────────────────────────────────────────────────────

    // Reference lists
    if (url.pathname === '/api/admin/reference-lists' && request.method === 'GET') {
      return addCors(await handleListReferenceLists(user, env), request);
    }

    const refMatch = url.pathname.match(/^\/api\/admin\/reference-lists\/(.+)$/);
    if (refMatch) {
      const name = decodeURIComponent(refMatch[1]);
      if (request.method === 'POST') {
        const cacheCount = url.searchParams.get('cache_count');
        return addCors(await handleUploadReferenceList(name, request, user, env, cacheCount ? parseInt(cacheCount) : null), request);
      }
      if (request.method === 'DELETE') {
        return addCors(await handleDeleteReferenceList(name, user, env), request);
      }
    }

    // Users list
    if (url.pathname === '/api/admin/users' && request.method === 'GET') {
      const { results } = await env.DB
        .prepare(`SELECT user_id, email, display_name, username, is_admin FROM users ORDER BY email`)
        .all<{ user_id: string; email: string; display_name: string | null; username: string | null; is_admin: number }>();
      return addCors(new Response(JSON.stringify({ users: results }), {
        headers: { 'Content-Type': 'application/json' },
      }), request);
    }

    // Users edit
    const userMatch = url.pathname.match(/^\/api\/admin\/users\/([\w-]+)$/);
    if (userMatch && request.method === 'PATCH') {
      const userId = decodeURIComponent(userMatch[1]);
      let body: { display_name?: string | null; username?: string | null; is_admin?: number };
      try { body = await request.json(); } catch { return addCors(jsonError('Invalid JSON'), request); }
      const fields: string[] = [];
      const values: unknown[] = [];
      if (body.display_name !== undefined) { fields.push('display_name = ?'); values.push(body.display_name); }
      if (body.username     !== undefined) { fields.push('username = ?');     values.push(body.username); }
      if (body.is_admin     !== undefined) { fields.push('is_admin = ?');     values.push(body.is_admin ? 1 : 0); }
      if (!fields.length) return addCors(jsonError('No fields to update'), request);
      values.push(userId);
      await env.DB.prepare(`UPDATE users SET ${fields.join(', ')} WHERE user_id = ?`).bind(...values).run();
      return addCors(new Response(JSON.stringify({ updated: true }), { headers: { 'Content-Type': 'application/json' } }), request);
    }

    // Jobs monitor with pagination
    if (url.pathname === '/api/admin/jobs' && request.method === 'GET') {
      const limit  = Math.min(parseInt(url.searchParams.get('limit')  ?? '25'), 100);
      const offset = parseInt(url.searchParams.get('offset') ?? '0');
      const status = url.searchParams.get('status');
      const query = status
        ? `SELECT job_id, module, job_type, status, user_id, attempt_count, error, created_at, updated_at FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
        : `SELECT job_id, module, job_type, status, user_id, attempt_count, error, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      const stmt = status
        ? env.DB.prepare(query).bind(status, limit, offset)
        : env.DB.prepare(query).bind(limit, offset);
      const { results } = await stmt.all();
      return addCors(new Response(JSON.stringify({ jobs: results }), {
        headers: { 'Content-Type': 'application/json' },
      }), request);
    }

    // Purge old completed/failed jobs
    if (url.pathname === '/api/admin/jobs/purge' && request.method === 'POST') {
      let body: { cutoff_ts?: number };
      try { body = await request.json(); } catch { body = {}; }
      const cutoff = body.cutoff_ts ?? (Math.floor(Date.now() / 1000) - 7 * 86400);
      await env.DB.prepare(
        `DELETE FROM jobs WHERE status IN ('complete', 'failed') AND created_at < ?`
      ).bind(cutoff).run();
      // D1 doesn't return affected row count easily — just confirm success
      return addCors(new Response(JSON.stringify({ deleted: true }), {
        headers: { 'Content-Type': 'application/json' },
      }), request);
    }

    // Rules list
    if (url.pathname === '/api/admin/rules' && request.method === 'GET') {
      return addCors(new Response(JSON.stringify({ rules: RULES }), {
        headers: { 'Content-Type': 'application/json' },
      }), request);
    }

    return addCors(jsonError('Not found', 404), request);
  },
};
