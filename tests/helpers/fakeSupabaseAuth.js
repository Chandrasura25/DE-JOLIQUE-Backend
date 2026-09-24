import crypto from 'node:crypto';
import http from 'node:http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

/**
 * A small stand-in for Supabase Auth (GoTrue): ES256 signing keys published as a
 * JWKS, password / refresh-token / PKCE grants, sign-up, recovery, logout and the
 * admin user update. Sign-ups are written to auth.users so the profile trigger runs.
 */
export async function startFakeSupabaseAuth(db) {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };

  const state = {
    url: null,
    autoconfirm: true,
    google: true,
    passwords: new Map(), // email -> { id, password }
    refreshTokens: new Map(), // token -> { userId, amr }
    codes: new Map(), // auth code -> { userId, challenge, amr }
    pendingChallenges: [], // { email, challenge, method, redirectTo }
    revoked: [],
    passwordUpdates: [],
  };

  const issuer = () => `${state.url}/auth/v1`;

  async function signAccessToken(userId, { email, amr = [{ method: 'password', timestamp: now() }], expiresIn = '1h' } = {}) {
    return new SignJWT({ email, role: 'authenticated', amr, user_metadata: {} })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key', typ: 'JWT' })
      .setIssuer(issuer())
      .setAudience('authenticated')
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  }

  async function issueSession(userId, amr) {
    const { rows } = await db.query('select email from auth.users where id = $1', [userId]);
    const email = rows[0]?.email;
    const refreshToken = crypto.randomBytes(16).toString('hex');
    state.refreshTokens.set(refreshToken, { userId, amr });
    return {
      access_token: await signAccessToken(userId, { email, amr }),
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      user: { id: userId, email, aud: 'authenticated', role: 'authenticated', identities: [{ provider: 'email' }] },
    };
  }

  /** Simulates the user clicking an emailed link / finishing Google: returns an auth code. */
  function completeFlow(userId, { method = 'oauth', challenge } = {}) {
    const pending = challenge ?? state.pendingChallenges.at(-1)?.challenge;
    const code = crypto.randomUUID();
    state.codes.set(code, { userId, challenge: pending, amr: [{ method, timestamp: now() }] });
    return code;
  }

  const routes = {
    'GET /auth/v1/.well-known/jwks.json': () => [200, { keys: [jwk] }],
    'GET /auth/v1/settings': () => [200, { external: { email: true, google: state.google } }],
    'GET /auth/v1/user': () => [401, { error_code: 'bad_jwt', msg: 'invalid JWT' }],

    'POST /auth/v1/token': async (body, url) => {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const account = state.passwords.get(String(body.email).toLowerCase());
        if (!account || account.password !== body.password) {
          return [400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' }];
        }
        await db.query('update auth.users set last_sign_in_at = now() where id = $1', [account.id]);
        return [200, await issueSession(account.id, [{ method: 'password', timestamp: now() }])];
      }
      if (grant === 'refresh_token') {
        const entry = state.refreshTokens.get(body.refresh_token);
        if (!entry) return [400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }];
        state.refreshTokens.delete(body.refresh_token);
        return [200, await issueSession(entry.userId, entry.amr)];
      }
      if (grant === 'id_token') {
        // Test tokens look like "fake-google.<userId>.<sha256 hex of the nonce>".
        const [kind, userId, hashedNonce] = String(body.id_token).split('.');
        const given = crypto.createHash('sha256').update(String(body.nonce ?? '')).digest('hex');
        if (body.provider !== 'google' || kind !== 'fake-google' || !body.nonce || given !== hashedNonce) {
          return [400, { error_code: 'bad_oauth_callback', msg: 'Passed nonce and nonce in id_token should either both exist or not.' }];
        }
        return [200, await issueSession(userId, [{ method: 'oauth', timestamp: now() }])];
      }
      if (grant === 'pkce') {
        const entry = state.codes.get(body.auth_code);
        state.codes.delete(body.auth_code);
        const challenge = crypto.createHash('sha256').update(String(body.code_verifier)).digest('base64url');
        if (!entry || entry.challenge !== challenge) {
          return [400, { error_code: 'bad_code_verifier', msg: 'code challenge does not match previously saved code verifier' }];
        }
        return [200, await issueSession(entry.userId, entry.amr)];
      }
      return [400, { msg: 'unsupported grant' }];
    },

    'POST /auth/v1/signup': async (body, url) => {
      const email = String(body.email).toLowerCase();
      if (state.passwords.has(email)) {
        // Supabase hides existing accounts when confirmations are on.
        return state.autoconfirm
          ? [422, { error_code: 'user_already_exists', msg: 'User already registered' }]
          : [200, { id: state.passwords.get(email).id, email, identities: [] }];
      }
      const { rows } = await db.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id', [
        email,
        JSON.stringify(body.data || {}),
      ]);
      const id = rows[0].id;
      state.passwords.set(email, { id, password: body.password });
      if (state.autoconfirm) return [200, await issueSession(id, [{ method: 'password', timestamp: now() }])];
      state.pendingChallenges.push({ email, challenge: body.code_challenge, redirectTo: url.searchParams.get('redirect_to') });
      return [200, { id, email, identities: [{ provider: 'email' }] }];
    },

    'POST /auth/v1/recover': async (body, url) => {
      state.pendingChallenges.push({
        email: String(body.email).toLowerCase(),
        challenge: body.code_challenge,
        redirectTo: url.searchParams.get('redirect_to'),
      });
      return [200, {}];
    },

    'POST /auth/v1/logout': (body, url, req) => {
      state.revoked.push({ token: req.headers.authorization?.slice(7), scope: url.searchParams.get('scope') });
      return [204, null];
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, state.url);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};

    let result;
    const adminUser = url.pathname.match(/^\/auth\/v1\/admin\/users\/([\w-]+)$/);
    if (req.method === 'PUT' && adminUser) {
      state.passwordUpdates.push({ id: adminUser[1], ...body });
      result = [200, { id: adminUser[1] }];
    } else if (req.method === 'GET' && url.pathname === '/auth/v1/admin/users') {
      const { rows } = await db.query('select id, email from auth.users order by email');
      result = [200, { users: rows, aud: 'authenticated' }];
    } else if (req.method === 'POST' && url.pathname === '/auth/v1/admin/users') {
      const { rows } = await db.query('select id from auth.users where lower(email) = lower($1)', [body.email]);
      if (rows[0]) {
        result = [422, { error_code: 'email_exists', msg: 'A user with this email address has already been registered' }];
      } else {
        const inserted = await db.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id', [
          body.email,
          JSON.stringify(body.user_metadata || {}),
        ]);
        state.passwords.set(body.email.toLowerCase(), { id: inserted.rows[0].id, password: body.password });
        result = [200, { id: inserted.rows[0].id, email: body.email }];
      }
    } else if (req.method === 'DELETE' && adminUser) {
      const { rowCount } = await db.query('delete from auth.users where id = $1', [adminUser[1]]);
      result = rowCount ? [200, {}] : [404, { error_code: 'user_not_found', msg: 'User not found' }];
    } else {
      const handler = routes[`${req.method} ${url.pathname}`];
      result = handler ? await handler(body, url, req) : [404, { msg: `fake auth: no route ${req.method} ${url.pathname}` }];
    }

    const [status, payload] = result;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload === null ? undefined : JSON.stringify(payload));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;

  return {
    state,
    get url() {
      return state.url;
    },
    privateKey,
    signAccessToken,
    issueSession,
    completeFlow,
    addPassword: (email, id, password) => state.passwords.set(email.toLowerCase(), { id, password }),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

const now = () => Math.floor(Date.now() / 1000);
