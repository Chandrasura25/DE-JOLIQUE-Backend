import env, { isProduction } from '../config/env.js';

/**
 * The Supabase session lives in httpOnly cookies scoped to the API, so browser
 * JavaScript (and any XSS) can never read the access or refresh token.
 */
export const ACCESS_COOKIE = 'jq_access';
export const REFRESH_COOKIE = 'jq_refresh';
const FLOW_COOKIE = 'jq_auth_flow';

const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const FLOW_MAX_AGE = 24 * 60 * 60 * 1000; // email confirmation links can take a while to be clicked

const sameSite = env.AUTH_COOKIE_SAME_SITE;
const base = { httpOnly: true, secure: isProduction || sameSite === 'none', sameSite, path: '/api' };
// The flow cookie must survive the top-level redirect back from Google or an email
// link, which a "strict" cookie would not.
const flowOptions = { ...base, sameSite: sameSite === 'strict' ? 'lax' : sameSite, path: '/api/auth' };

export function setSessionCookies(res, session) {
  const accessMaxAge = Math.max(60, Number(session.expires_in) || 3600) * 1000;
  res.cookie(ACCESS_COOKIE, session.access_token, { ...base, maxAge: accessMaxAge });
  res.cookie(REFRESH_COOKIE, session.refresh_token, { ...base, maxAge: REFRESH_MAX_AGE });
}

export function clearSessionCookies(res) {
  res.clearCookie(ACCESS_COOKIE, base);
  res.clearCookie(REFRESH_COOKIE, base);
}

/** Remembers a PKCE verifier (and where to land afterwards) until /api/auth/callback. */
export function setFlowCookie(res, { verifier, next }) {
  res.cookie(FLOW_COOKIE, JSON.stringify({ v: verifier, next }), { ...flowOptions, maxAge: FLOW_MAX_AGE });
}

export function takeFlowCookie(req, res) {
  const raw = req.cookies?.[FLOW_COOKIE];
  if (!raw) return null;
  res.clearCookie(FLOW_COOKIE, flowOptions);
  try {
    const flow = JSON.parse(raw);
    return typeof flow?.v === 'string' ? { verifier: flow.v, next: safeNext(flow.next) } : null;
  } catch {
    return null;
  }
}

/** Only same-site relative paths, so a crafted link can't bounce users to another site. */
export function safeNext(value, fallback = '/account') {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) && value.length <= 200 ? value : fallback;
}
