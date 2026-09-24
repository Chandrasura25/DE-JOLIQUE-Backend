import { clientOrigins } from '../config/env.js';
import asyncHandler from '../utils/asyncHandler.js';
import { clearSessionCookies, safeNext, setFlowCookie, setSessionCookies, takeFlowCookie } from '../utils/authCookies.js';
import { authenticate } from '../middleware/auth.js';
import {
  changePassword,
  exchangeCode,
  getAuthProviders,
  getOrCreateProfile,
  requestPasswordReset,
  resetPassword,
  signInWithPassword,
  signOut,
  signUp,
  startOAuth,
  toUserDto,
  updateProfile,
  verifyAccessToken,
} from '../services/authService.js';

// Sign-up, sign-in, Google, refresh and sign-out all go through this API. Supabase Auth
// issues the tokens; the API keeps them in httpOnly cookies and refreshes them itself.

const storefront = (path, params) => {
  const url = new URL(path, clientOrigins[0]);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
  return url.toString();
};

async function startSession(res, session) {
  setSessionCookies(res, session);
  return getOrCreateProfile(await verifyAccessToken(session.access_token));
}

/** POST /api/auth/register */
export const register = asyncHandler(async (req, res) => {
  const { next, ...details } = req.body;
  const { session, verifier } = await signUp(details);
  if (!session) {
    // Email confirmation is on: the link in the email comes back to /api/auth/callback.
    if (verifier) setFlowCookie(res, { verifier, next: safeNext(next) });
    return res.status(201).json({ success: true, needsConfirmation: true, message: 'Check your email to confirm your account.' });
  }
  const profile = await startSession(res, session);
  return res.status(201).json({ success: true, needsConfirmation: false, user: toUserDto(profile) });
});

/** POST /api/auth/login */
export const login = asyncHandler(async (req, res) => {
  const session = await signInWithPassword(req.body.email, req.body.password);
  const profile = await startSession(res, session);
  res.json({ success: true, user: toUserDto(profile) });
});

/** POST /api/auth/logout — always succeeds, even without a session. */
export const logout = asyncHandler(async (req, res) => {
  const auth = await authenticate(req, res).catch(() => null);
  if (auth) await signOut(auth.accessToken);
  clearSessionCookies(res);
  res.json({ success: true, message: 'Signed out.' });
});

/** GET /api/auth/google — browser navigation, redirects to Google via Supabase Auth. */
export const googleSignIn = asyncHandler(async (req, res) => {
  const next = safeNext(req.query.next);
  const providers = await getAuthProviders();
  if (!providers.google) return res.redirect(storefront('/login', { auth: 'unavailable' }));
  const { url, verifier } = await startOAuth('google');
  setFlowCookie(res, { verifier, next });
  return res.redirect(url);
});

/**
 * GET /api/auth/callback — where Supabase Auth returns the browser after Google,
 * an email confirmation link or a password-recovery link.
 */
export const authCallback = asyncHandler(async (req, res) => {
  const flow = takeFlowCookie(req, res);
  const { code, error: providerError } = req.query;

  if (providerError || typeof code !== 'string' || !code) {
    const reason = /access_denied/.test(String(providerError)) ? 'cancelled' : 'failed';
    return res.redirect(storefront('/login', { auth: reason }));
  }
  // Link opened in a different browser than the one that started the flow: Supabase
  // has already confirmed the email, but this browser can't finish the sign-in.
  if (!flow) return res.redirect(storefront('/login', { auth: 'verified' }));

  try {
    const { session, redirectType } = await exchangeCode(code, flow.verifier);
    setSessionCookies(res, session);
    return res.redirect(storefront(redirectType === 'recovery' ? '/reset-password' : flow.next));
  } catch {
    return res.redirect(storefront('/login', { auth: 'expired' }));
  }
});

/** POST /api/auth/forgot-password — the same response whether or not the account exists. */
export const forgotPassword = asyncHandler(async (req, res) => {
  const verifier = await requestPasswordReset(req.body.email);
  if (verifier) setFlowCookie(res, { verifier, next: '/reset-password' });
  res.json({ success: true, message: 'If an account exists for that email, a reset link is on its way.' });
});

/** POST /api/auth/reset-password — only from a session opened by a recovery link. */
export const resetMyPassword = asyncHandler(async (req, res) => {
  const profile = await resetPassword(req.auth.claims, req.body.password);
  res.json({ success: true, message: 'Password updated.', user: toUserDto(profile) });
});

/** GET /api/auth/providers */
export const getProviders = asyncHandler(async (req, res) => {
  res.json({ success: true, providers: { email: true, ...(await getAuthProviders()) } });
});

/** GET /api/auth/me */
export const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, user: toUserDto(req.user) });
});

/** PUT /api/auth/me */
export const updateMe = asyncHandler(async (req, res) => {
  const profile = await updateProfile(req.user.id, req.body);
  res.json({ success: true, message: 'Profile updated.', user: toUserDto(profile) });
});

/** PUT /api/auth/change-password */
export const changeMyPassword = asyncHandler(async (req, res) => {
  const profile = await changePassword(req.user, req.body.currentPassword, req.body.newPassword);
  res.json({ success: true, message: 'Password changed successfully.', user: toUserDto(profile) });
});
