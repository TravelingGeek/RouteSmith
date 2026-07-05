/**
 * referenceLists.ts — Admin endpoints for managing reference list files.
 *
 * Reference lists are GPX files used by the REPORT pipeline for rules:
 *   - oldest_active_per_state.gpx
 *   - oldest_active_per_country.gpx
 *   - cache_across_america.gpx
 *   - cache_odyssey.gpx
 *
 * Files are stored in R2 at ReferenceLists/<filename>.
 * The REPORT pipeline reads them from R2 at job execution time.
 */

import type { Env } from './types.js';
import type { AuthUser } from './auth.js';

const REFERENCE_LIST_PREFIX = 'ReferenceLists/';

const ALLOWED_REFERENCE_FILES = new Set([
  'oldest_active_per_state.gpx',
  'oldest_active_per_country.gpx',
  'cache_across_america.gpx',
  'cache_odyssey.gpx',
]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// ============================================================================
// GET /api/admin/reference-lists
// List all reference files with metadata
// ============================================================================

export async function handleListReferenceLists(
  user: AuthUser,
  env: Env,
): Promise<Response> {
  const listed = await env.DATA_BUCKET.list({ prefix: REFERENCE_LIST_PREFIX });

  const files = listed.objects.map(obj => ({
    name: obj.key.replace(REFERENCE_LIST_PREFIX, ''),
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded?.toISOString() ?? null,
    contentType: obj.httpMetadata?.contentType ?? null,
    uploadedBy: obj.customMetadata?.uploaded_by ?? null,
  }));

  // Also show which expected files are missing
  const presentNames = new Set(files.map(f => f.name));
  const missing = [...ALLOWED_REFERENCE_FILES].filter(n => !presentNames.has(n));

  return jsonResponse({ files, missing, total: files.length });
}

// ============================================================================
// POST /api/admin/reference-lists/:name
// Upload a reference file
// ============================================================================

export async function handleUploadReferenceList(
  name: string,
  request: Request,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  if (!ALLOWED_REFERENCE_FILES.has(name)) {
    return jsonError(
      `Unknown reference file: ${name}. Allowed: ${[...ALLOWED_REFERENCE_FILES].join(', ')}`,
    );
  }

  const contentType = request.headers.get('Content-Type') ?? 'application/gpx+xml';
  const body = await request.arrayBuffer();

  if (!body.byteLength) return jsonError('Request body is empty');
  if (body.byteLength > 50 * 1024 * 1024) return jsonError('File too large (max 50MB)');

  const key = `${REFERENCE_LIST_PREFIX}${name}`;

  await env.DATA_BUCKET.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: {
      uploaded_by: user.userId,
      uploaded_at: new Date().toISOString(),
      original_name: name,
    },
  });

  // Log the upload in D1
  await env.DB.prepare(`
    INSERT INTO gpx_file_events (
      event_id, gpx_file_id, event_type, executed_by_user_id, note, occurred_at
    ) VALUES (?, 'system', 'reference_list_uploaded', ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    user.userId,
    `Reference list uploaded: ${name} (${body.byteLength} bytes)`,
    Math.floor(Date.now() / 1000),
  ).run();

  return jsonResponse({
    name,
    key,
    size: body.byteLength,
    uploaded_by: user.userId,
    uploaded_at: new Date().toISOString(),
  }, 201);
}

// ============================================================================
// DELETE /api/admin/reference-lists/:name
// Delete a reference file
// ============================================================================

export async function handleDeleteReferenceList(
  name: string,
  user: AuthUser,
  env: Env,
): Promise<Response> {
  if (!ALLOWED_REFERENCE_FILES.has(name)) {
    return jsonError(`Unknown reference file: ${name}`);
  }

  const key = `${REFERENCE_LIST_PREFIX}${name}`;
  const existing = await env.DATA_BUCKET.get(key);
  if (!existing) return jsonError(`File not found: ${name}`, 404);

  await env.DATA_BUCKET.delete(key);

  return jsonResponse({ deleted: true, name, key });
}
