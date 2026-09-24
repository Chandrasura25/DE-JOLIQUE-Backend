import { createClient } from '@supabase/supabase-js';
import env from './env.js';

const AUTH_STORAGE_KEY = 'jq-auth';
/** Where supabase-js keeps the verifier of the most recently started PKCE flow. */
export const PKCE_VERIFIER_KEY = `${AUTH_STORAGE_KEY}-code-verifier`;

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

/**
 * Service-role client: bypasses RLS and can use the Auth Admin API.
 * Server-side only — the service role key must never reach the browser.
 */
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, clientOptions);

/**
 * A fresh anon client per call for user-facing auth (password sign-in, sign-up,
 * OAuth, refresh). Sessions are never shared between requests: the only thing it
 * stores is the PKCE code verifier, kept in `storage` so the caller can carry it to
 * the callback request in a cookie.
 */
export function createAuthClient(storage = new Map()) {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      ...clientOptions.auth,
      // supabase-js ignores custom storage unless it may persist; `storage` is per request.
      persistSession: true,
      flowType: 'pkce',
      storageKey: AUTH_STORAGE_KEY,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => void storage.set(key, value),
        removeItem: (key) => void storage.delete(key),
      },
    },
  });
  return { client, storage };
}

