import env, { clientOrigins } from '../config/env.js';
import asyncHandler from '../utils/asyncHandler.js';
import AppError from '../utils/AppError.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, clearSessionCookies, setSessionCookies } from '../utils/authCookies.js';
import { verifyAccessToken, getOrCreateProfile, isInvalidTokenError, refreshSession } from '../services/authService.js';

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : null;
}

async function verifyOrNull(token) {
  try {
    return await verifyAccessToken(token);
  } catch (err) {
    if (isInvalidTokenError(err)) return null;
    throw err;
  }
}

/**
 * Resolves the caller's Supabase session: an `Authorization: Bearer` header (API
 * clients, Swagger) or the session cookies set by /api/auth/*. An expired cookie
 * session is refreshed here with the refresh token and the new tokens are written
 * back, so the browser never handles token refresh.
 *
 * Returns { claims, accessToken } or null when there is no valid session.
 */
export async function authenticate(req, res) {
  const header = bearerToken(req);
  if (header) {
    const claims = await verifyOrNull(header);
    return claims ? { claims, accessToken: header } : null;
  }

  const access = req.cookies?.[ACCESS_COOKIE];
  if (access) {
    const claims = await verifyOrNull(access);
    if (claims) return { claims, accessToken: access };
  }

  const refresh = req.cookies?.[REFRESH_COOKIE];
  if (!refresh) return null;
  try {
    const session = await refreshSession(refresh);
    const claims = await verifyAccessToken(session.access_token);
    setSessionCookies(res, session);
    return { claims, accessToken: session.access_token };
  } catch (err) {
    if (!isInvalidTokenError(err)) throw err;
    // Revoked or already-used refresh token: the session is over.
    clearSessionCookies(res);
    return null;
  }
}

/** Requires a valid Supabase session. Sets req.user to the profile row and req.auth to the session. */
export const protect = asyncHandler(async (req, res, next) => {
  const hadCredentials = Boolean(bearerToken(req) || req.cookies?.[ACCESS_COOKIE] || req.cookies?.[REFRESH_COOKIE]);
  const auth = await authenticate(req, res);
  if (!auth?.claims?.sub) {
    throw AppError.unauthorized(hadCredentials ? 'Your session has expired. Please log in again.' : undefined);
  }
  req.auth = auth;
  req.user = await getOrCreateProfile(auth.claims);
  if (!req.user) throw AppError.unauthorized('This account no longer exists.');
  next();
});

/**
 * Must run after protect. The role is read from public.profiles on every request,
 * so hiding admin pages in React is never the only line of defence.
 */
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return next(AppError.forbidden('Admin access only.'));
  }
  if (req.user.must_change_password) {
    const err = AppError.forbidden('Please change your password before using the admin dashboard.');
    err.code = 'PASSWORD_CHANGE_REQUIRED';
    return next(err);
  }
  return next();
}

export const adminOnly = [protect, requireAdmin];

const trustedOrigins = new Set([...clientOrigins, new URL(env.SERVER_URL).origin]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for cookie sessions: browsers always send Origin on cross-origin
 * writes, so any state-changing request from a page that isn't the storefront is
 * refused. Server-to-server calls (payment webhooks) send no Origin and pass.
 */
export function rejectUntrustedOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (SAFE_METHODS.has(req.method) || !origin || trustedOrigins.has(origin)) return next();
  return next(AppError.forbidden('This request came from an untrusted site.'));
}
