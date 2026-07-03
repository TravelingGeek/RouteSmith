/**
 * auth.ts — Clerk JWT validation middleware for the Routesmith REPORT Worker.
 *
 * Validates the Bearer token on every request using Clerk's published JWKS
 * (JSON Web Key Set). Extracts user ID, email, and display name from the
 * validated claims.
 *
 * Clerk publishes its public keys at:
 *   https://ready-redbird-56.clerk.accounts.dev/.well-known/jwks.json
 *
 * The JWKS is cached in memory for the lifetime of the Worker instance
 * (typically minutes). No persistent cache needed — Clerk rotates keys
 * infrequently and the Worker will re-fetch on cold start.
 */

export interface AuthUser {
  userId: string;       // Clerk user ID (the JWT `sub` claim)
  email: string;
  displayName: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// ============================================================================
// JWKS cache
// ============================================================================

const CLERK_FRONTEND_API = 'https://ready-redbird-56.clerk.accounts.dev';
const JWKS_URL = `${CLERK_FRONTEND_API}/.well-known/jwks.json`;

// In-memory cache: key ID → CryptoKey
const jwksCache = new Map<string, CryptoKey>();
let jwksFetchedAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000; // re-fetch after 1 hour

async function getPublicKey(kid: string): Promise<CryptoKey> {
  const now = Date.now();
  const needsRefresh = !jwksCache.has(kid) || (now - jwksFetchedAt) > JWKS_TTL_MS;

  if (needsRefresh) {
    const resp = await fetch(JWKS_URL);
    if (!resp.ok) {
      throw new AuthError(`Failed to fetch Clerk JWKS: ${resp.status}`, 500);
    }
    const { keys } = await resp.json() as { keys: JsonWebKey[] & { kid?: string; use?: string }[] };

    jwksCache.clear();
    for (const jwk of keys) {
      const key = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      if (jwk.kid) jwksCache.set(jwk.kid, key);
    }
    jwksFetchedAt = now;
  }

  const key = jwksCache.get(kid);
  if (!key) throw new AuthError('Unknown JWT key ID — token may be expired or invalid');
  return key;
}

// ============================================================================
// JWT validation
// ============================================================================

function base64UrlDecode(s: string): Uint8Array {
  // Convert base64url to base64, then decode
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    s.length + (4 - (s.length % 4)) % 4, '='
  );
  const binary = atob(b64);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

interface JwtHeader {
  alg: string;
  kid: string;
}

interface JwtClaims {
  sub: string;
  email?: string;
  display_name?: string;
  image_url?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
}

/**
 * Validate a Clerk JWT and return the verified claims.
 * Throws AuthError for any validation failure.
 */
async function verifyJwt(token: string): Promise<JwtClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed JWT');

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode header to get key ID
  let header: JwtHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
  } catch {
    throw new AuthError('Malformed JWT header');
  }

  if (header.alg !== 'RS256') {
    throw new AuthError(`Unexpected JWT algorithm: ${header.alg}`);
  }
  if (!header.kid) {
    throw new AuthError('JWT missing key ID');
  }

  // Fetch the matching public key
  const publicKey = await getPublicKey(header.kid);

  // Verify signature
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signature,
    signingInput,
  );
  if (!valid) throw new AuthError('JWT signature invalid');

  // Decode and validate claims
  let claims: JwtClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    throw new AuthError('Malformed JWT payload');
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && now > claims.exp) {
    throw new AuthError('JWT expired');
  }
  if (claims.nbf && now < claims.nbf) {
    throw new AuthError('JWT not yet valid');
  }
  if (!claims.sub) {
    throw new AuthError('JWT missing sub claim');
  }

  return claims;
}

// ============================================================================
// Public middleware
// ============================================================================

/**
 * Extract and validate the Bearer token from an incoming request.
 * Returns the authenticated user on success.
 * Throws AuthError on any auth failure — caller should catch and return 401.
 *
 * Usage in worker.ts:
 *   const user = await requireAuth(request);
 */
export async function requireAuth(request: Request): Promise<AuthUser> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError('Missing or malformed Authorization header');
  }

  const token = authHeader.slice(7);
  const claims = await verifyJwt(token);

  return {
    userId: claims.sub,
    email: claims.email ?? '',
    displayName: claims.display_name ?? claims.email ?? claims.sub,
  };
}

/**
 * Build a 401 Unauthorized response with a JSON error body.
 * Use this to handle AuthError in the Worker fetch handler.
 */
export function unauthorizedResponse(message: string): Response {
  return new Response(
    JSON.stringify({ error: message }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="Routesmith"',
      },
    },
  );
}
