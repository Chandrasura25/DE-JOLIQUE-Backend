import crypto from 'node:crypto';
import { createRemoteJWKSet, decodeJwt, jwtVerify, errors as joseErrors } from 'jose';
import env from '../config/env.js';
import { query, withTransaction } from '../config/db.js';
import { supabaseAdmin, createAuthClient, PKCE_VERIFIER_KEY } from '../config/supabase.js';
import AppError from '../utils/AppError.js';

const issuer = `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const verifyOptions = { issuer, audience: 'authenticated' };

/** Where Supabase Auth sends the browser back after Google, email confirmation and password recovery. */
export const authCallbackUrl = `${env.SERVER_URL.replace(/\/+$/, '')}/api/auth/callback`;

/**
 * Verifies a Supabase Auth access token and returns its claims.
 *
 * Tokens are checked locally against the project's signing keys (JWKS). Projects still
 * on the legacy shared HS256 secret publish no matching key, so those tokens are
 * checked by asking Supabase Auth instead. No JWT secret is needed either way.
 */
export async function verifyAccessToken(token) {
  try {
    const { payload } = await jwtVerify(token, jwks, verifyOptions);
    return payload;
  } catch (err) {
    if (!(err instanceof joseErrors.JWKSNoMatchingKey)) throw err;
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) throw error || Object.assign(new Error('Invalid token'), { status: 401 });
    // Supabase Auth has vouched for the token, so its claims can be read as-is.
    return decodeJwt(token);
  }
}

/** True for "this token is bad" failures, false for outages (JWKS or Auth unreachable). */
export function isInvalidTokenError(err) {
  if (err instanceof joseErrors.JWKSTimeout) return false;
  if (err instanceof joseErrors.JOSEError) return true;
  return err?.status >= 400 && err.status < 500;
}

// ---------------------------------------------------------------------------
// Sessions. Supabase issues the access/refresh tokens; the API keeps them in
// httpOnly cookies (utils/authCookies.js) so browser JavaScript never sees them.
// ---------------------------------------------------------------------------

const AUTH_MESSAGES = [
  [/invalid login credentials/i, 'Invalid email or password.'],
  [/email not confirmed/i, 'Please confirm your email address first. Check your inbox for the confirmation link.'],
  [/already registered|already been registered|user already exists/i, 'An account with this email already exists. Try logging in.'],
  [/password should be at least|weak password|password is known/i, 'Password is too weak. Use at least 8 characters with letters and numbers.'],
  [/rate limit|too many|security purposes/i, 'Too many attempts. Please wait a few minutes and try again.'],
];

/** Turns a Supabase Auth error into a message that is safe to show to the customer. */
function authError(error, fallback) {
  const match = AUTH_MESSAGES.find(([pattern]) => pattern.test(error?.message || ''));
  if (match) return new AppError(match[1], match === AUTH_MESSAGES.at(-1) ? 429 : 400);
  if (!error?.status || error.status >= 500) {
    return AppError.unavailable('Authentication is temporarily unavailable. Please try again.');
  }
  return AppError.badRequest(fallback);
}

export async function signInWithPassword(email, password) {
  const { client } = createAuthClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw authError(error, 'Invalid email or password.');
  return data.session;
}

/**
 * Creates a Supabase Auth user. When the project requires email confirmation there is
 * no session yet, and `verifier` must travel with the browser to the callback.
 */
export async function signUp({ name, email, phone, password }) {
  const { client, storage } = createAuthClient();
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { name, phone: phone || '' }, emailRedirectTo: authCallbackUrl },
  });
  if (error) throw authError(error, 'Unable to create your account.');
  // With confirmations on, Supabase answers an existing email with a stand-in user that
  // has no identities. Reply exactly as for a new sign-up, so the endpoint can't be
  // used to find out who is a customer (the real owner can log in or reset instead).
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { session: null, verifier: null };
  }
  return { session: data.session, verifier: storage.get(PKCE_VERIFIER_KEY) ?? null };
}

/** Starts an OAuth sign-in. Returns the provider URL to redirect to and the PKCE verifier. */
export async function startOAuth(provider) {
  const { client, storage } = createAuthClient();
  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo: authCallbackUrl, skipBrowserRedirect: true },
  });
  if (error || !data?.url) throw authError(error, 'Unable to start sign-in.');
  return { url: data.url, verifier: storage.get(PKCE_VERIFIER_KEY) };
}

/**
 * Google One Tap: a fresh random nonce per prompt. The browser only ever gets its
 * SHA-256 (which Google embeds in the ID token); the raw value stays in an httpOnly
 * cookie and is required to redeem the token, so a stolen ID token is useless.
 */
export function createOneTapNonce() {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
}

/** Exchanges a Google One Tap ID token (verified by Supabase Auth) for a session. */
export async function signInWithGoogleIdToken(idToken, rawNonce) {
  const { client } = createAuthClient();
  const { data, error } = await client.auth.signInWithIdToken({ provider: 'google', token: idToken, nonce: rawNonce });
  if (error || !data?.session) throw authError(error, 'Google sign-in failed. Please try again.');
  return data.session;
}

/** Finishes an OAuth or email-link flow that was started with a PKCE verifier. */
export async function exchangeCode(code, verifier) {
  const { client } = createAuthClient(new Map([[PKCE_VERIFIER_KEY, verifier]]));
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error || !data?.session) throw error || new Error('No session returned');
  return { session: data.session, redirectType: data.redirectType };
}

/** Throws the Supabase error unchanged so callers can tell a revoked token from an outage. */
export async function refreshSession(refreshToken) {
  const { client } = createAuthClient();
  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data?.session) throw error || Object.assign(new Error('No session returned'), { status: 401 });
  return data.session;
}

/** Revokes this session's refresh tokens (other devices stay signed in). */
export async function signOut(accessToken) {
  await supabaseAdmin.auth.admin.signOut(accessToken, 'local').catch(() => {});
}

/** Sends the recovery email. Returns the PKCE verifier the reset link will need. */
export async function requestPasswordReset(email) {
  const { client, storage } = createAuthClient();
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: authCallbackUrl });
  if (error) throw authError(error, 'Unable to send the reset email.');
  return storage.get(PKCE_VERIFIER_KEY) ?? null;
}

const RECOVERY_WINDOW_SECONDS = 60 * 60;

/** True when the session was started from a password-recovery link within the last hour. */
export function isRecoverySession(claims) {
  const now = Date.now() / 1000;
  return (
    Array.isArray(claims?.amr) &&
    claims.amr.some((entry) => entry?.method === 'recovery' && now - Number(entry.timestamp) < RECOVERY_WINDOW_SECONDS)
  );
}

/** Sets a new password for a user who signed in through a recovery link. */
export async function resetPassword(claims, newPassword) {
  if (!isRecoverySession(claims)) {
    throw AppError.forbidden('This reset link has expired. Please request a new one.');
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(claims.sub, { password: newPassword });
  if (error) throw authError(error, 'Unable to update your password.');
  const { rows } = await query(
    `update public.profiles set must_change_password = false where id = $1 returning ${PROFILE_COLUMNS}`,
    [claims.sub],
  );
  return rows[0];
}

let providerCache = { value: null, expires: 0 };

/**
 * Which sign-in providers are switched on in Supabase Auth, so the storefront only
 * shows buttons that work. Cached for five minutes (30 seconds after a failure).
 */
export async function getAuthProviders() {
  if (providerCache.value && providerCache.expires > Date.now()) return providerCache.value;
  let value = { google: false };
  let ttl = 30_000;
  try {
    const res = await fetch(`${issuer}/settings`, {
      headers: { apikey: env.SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const settings = await res.json();
      value = { google: Boolean(settings.external?.google) };
      ttl = 5 * 60_000;
    }
  } catch {
    // Supabase unreachable: hide optional providers and check again shortly.
  }
  providerCache = { value, expires: Date.now() + ttl };
  return value;
}

const PROFILE_COLUMNS = 'id, email, name, phone, role, must_change_password, created_at, updated_at';

export function toUserDto(profile) {
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    role: profile.role,
    mustChangePassword: profile.must_change_password,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
  };
}

/**
 * Loads the profile for a verified token. The database trigger normally creates it at
 * sign-up; this backfills it if the trigger was added after the user signed up.
 * Role always comes from the database, never from the token.
 */
export async function getOrCreateProfile(claims) {
  const existing = await query(`select ${PROFILE_COLUMNS} from public.profiles where id = $1`, [claims.sub]);
  if (existing.rows[0]) return existing.rows[0];

  // Only while the auth user still exists: a deleted account's access token stays
  // cryptographically valid until it expires, but must not bring the profile back.
  const meta = claims.user_metadata || {};
  const inserted = await query(
    `insert into public.profiles (id, email, name, phone)
     select u.id, $2, left($3, 100), nullif(left($4, 30), '') from auth.users u where u.id = $1
     on conflict (id) do update set email = excluded.email
     returning ${PROFILE_COLUMNS}`,
    [claims.sub, claims.email || '', String(meta.name || ''), String(meta.phone || '')],
  );
  return inserted.rows[0] || null;
}

export async function getProfileById(id) {
  const { rows } = await query(`select ${PROFILE_COLUMNS} from public.profiles where id = $1`, [id]);
  return rows[0] || null;
}

export async function updateProfile(id, { name, phone }) {
  const { rows } = await query(
    `update public.profiles
        set name = coalesce($2, name),
            phone = case when $3::boolean then nullif($4, '') else phone end
      where id = $1
      returning ${PROFILE_COLUMNS}`,
    [id, name ?? null, phone !== undefined, phone ?? ''],
  );
  // Keep Supabase Auth's user_metadata in sync (used in Supabase emails/dashboard).
  await supabaseAdmin.auth.admin
    .updateUserById(id, { user_metadata: { name: rows[0].name, phone: rows[0].phone || '' } })
    .catch(() => {});
  return rows[0];
}

/**
 * Changes a password after proving the user knows the current one.
 * Clears the must_change_password flag set on seeded admin accounts.
 */
export async function changePassword(profile, currentPassword, newPassword) {
  if (currentPassword === newPassword) {
    throw AppError.badRequest('Your new password must be different from your current password.');
  }
  const { client } = createAuthClient();
  const { data, error: signInError } = await client.auth.signInWithPassword({ email: profile.email, password: currentPassword });
  if (signInError) throw AppError.badRequest('Your current password is incorrect.');
  // The sign-in only proves the password; revoke the extra session it created.
  await signOut(data.session.access_token);

  const { error } = await supabaseAdmin.auth.admin.updateUserById(profile.id, { password: newPassword });
  if (error) throw AppError.badRequest(error.message || 'Unable to change password.');

  const { rows } = await query(
    `update public.profiles set must_change_password = false where id = $1 returning ${PROFILE_COLUMNS}`,
    [profile.id],
  );
  return rows[0];
}

/** The store's single admin (the database allows at most one), or null. */
export async function getAdminProfile() {
  const { rows } = await query(`select ${PROFILE_COLUMNS} from public.profiles where role = 'admin'`);
  return rows[0] || null;
}

/**
 * Creates (or promotes) the store's admin account in Supabase Auth. There is only
 * ever one admin: if a different account holds the role this refuses, unless
 * `replace` is set, in which case the current admin becomes a customer.
 * Used by the seed and create-admin scripts.
 */
export async function upsertAdminUser({ email, password, name, mustChangePassword = true, replace = false }) {
  const normalizedEmail = email.trim().toLowerCase();
  let userId;

  // Checked before touching Supabase Auth so a refusal leaves no stray account behind.
  const currentAdmin = await getAdminProfile();
  if (currentAdmin && currentAdmin.email.toLowerCase() !== normalizedEmail && !replace) {
    throw Object.assign(
      new Error(`${currentAdmin.email} is already the admin, and the store allows only one. Use --replace to hand the role over.`),
      { code: 'ADMIN_EXISTS', adminEmail: currentAdmin.email },
    );
  }

  const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true,
    user_metadata: { name },
  });

  if (created?.user) {
    userId = created.user.id;
  } else if (error && /already|registered|exists/i.test(error.message)) {
    const found = await findAuthUserByEmail(normalizedEmail);
    if (!found) throw new Error(`User ${normalizedEmail} exists but could not be looked up.`);
    userId = found.id;
  } else {
    throw new Error(error?.message || 'Unable to create admin user in Supabase Auth.');
  }

  // The auth.users trigger has usually created the profile already, so the conflict
  // branch is the normal path. Only a newly created account gets the forced change.
  const profile = await withTransaction(async (client) => {
    if (replace) await client.query(`update public.profiles set role = 'customer' where role = 'admin' and id <> $1`, [userId]);
    const { rows } = await client.query(
      `insert into public.profiles (id, email, name, role, must_change_password)
       values ($1, $2, $3, 'admin', $4)
       on conflict (id) do update
         set role = 'admin',
             name = coalesce(nullif(public.profiles.name, ''), excluded.name),
             must_change_password = case when $5 then excluded.must_change_password
                                          else public.profiles.must_change_password end
       returning ${PROFILE_COLUMNS}`,
      [userId, normalizedEmail, name, mustChangePassword, Boolean(created?.user)],
    );
    return rows[0];
  });
  return { profile, created: Boolean(created?.user), replaced: replace && currentAdmin?.id !== userId ? currentAdmin : null };
}

async function findAuthUserByEmail(email) {
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = data.users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match;
    if (data.users.length < 200) return null;
  }
  return null;
}
