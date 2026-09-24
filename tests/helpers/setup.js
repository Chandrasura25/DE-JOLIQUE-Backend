import crypto from 'node:crypto';
import { SignJWT, generateKeyPair } from 'jose';
import pg from 'pg';
import { startTestDatabase } from './testDatabase.js';
import { applySupabaseMigrations } from './applyMigrations.js';
import { startFakeSupabaseAuth } from './fakeSupabaseAuth.js';

export const FLW_HASH = 'test-flutterwave-webhook-hash';

let fakeAuth;

/**
 * Boots a real Postgres, applies the Supabase migrations, starts a fake Supabase Auth,
 * configures env for the app and returns helpers. Env must be set before the app
 * modules are imported.
 */
export async function setupTestApp() {
  const db = await startTestDatabase();
  const admin = new pg.Pool({ connectionString: db.url });
  await applySupabaseMigrations(admin);
  fakeAuth = await startFakeSupabaseAuth(admin);

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: db.url,
    DATABASE_SSL: 'false',
    SUPABASE_URL: fakeAuth.url,
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    CLIENT_URL: 'http://localhost:5173',
    SERVER_URL: 'http://localhost:5000',
    STORAGE_PROVIDER: 'local',
    PAYSTACK_SECRET_KEY: 'sk_test_paystack',
    FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-flutterwave',
    FLUTTERWAVE_WEBHOOK_HASH: FLW_HASH,
    SHIPPING_FEE: '1500',
    LOW_STOCK_THRESHOLD: '5',
    CURRENCY: 'NGN',
    CRON_SECRET: 'test-cron-secret',
  });

  const { createApp } = await import('../../src/app.js');
  const dbModule = await import('../../src/config/db.js');
  const paymentModule = await import('../../src/services/paymentService.js');
  const app = createApp();

  async function createUser({ role = 'customer', name = 'Test User', email, mustChangePassword = false, password } = {}) {
    const mail = email || `user-${crypto.randomUUID().slice(0, 8)}@example.com`;
    // Simulates Supabase Auth sign-up: inserting into auth.users fires the profile trigger.
    const { rows } = await admin.query(
      'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
      [mail, JSON.stringify({ name, phone: '08012345678' })],
    );
    const id = rows[0].id;
    // The store allows a single admin (unique index): a new test admin replaces the last one.
    if (role === 'admin') await admin.query(`update public.profiles set role = 'customer' where role = 'admin'`);
    await admin.query('update public.profiles set role = $2, must_change_password = $3 where id = $1', [
      id,
      role,
      mustChangePassword,
    ]);
    if (password) fakeAuth.addPassword(mail, id, password);
    const token = await signToken({ sub: id, email: mail });
    return { id, email: mail, token, auth: { Authorization: `Bearer ${token}` } };
  }

  async function createCategory(name = `Cat ${crypto.randomUUID().slice(0, 6)}`) {
    const { rows } = await admin.query(
      'insert into public.categories (name, slug, description) values ($1, $2, $3) returning *',
      [name, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), 'desc'],
    );
    return rows[0];
  }

  async function createProduct(overrides = {}) {
    const name = overrides.name || `Product ${crypto.randomUUID().slice(0, 8)}`;
    const { rows } = await admin.query(
      `insert into public.products (name, slug, description, price, stock, category_id, featured, is_active, images)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) returning *`,
      [
        name,
        name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        overrides.description || 'A great product for testing.',
        overrides.price ?? 1000,
        overrides.stock ?? 10,
        overrides.categoryId ?? null,
        overrides.featured ?? false,
        overrides.isActive ?? true,
        JSON.stringify(overrides.images || [{ url: 'https://example.com/a.jpg', key: null, provider: 'external' }]),
      ],
    );
    return rows[0];
  }

  async function teardown() {
    await fakeAuth.stop().catch(() => {});
    await admin.end().catch(() => {});
    await dbModule.closeDatabase().catch(() => {});
    await db.stop();
  }

  return {
    app,
    db: admin,
    auth: fakeAuth,
    gateways: paymentModule.gateways,
    paymentService: paymentModule,
    createUser,
    createCategory,
    createProduct,
    teardown,
  };
}

/**
 * Signs an access token the way Supabase Auth does (ES256, key published in the JWKS).
 * `forged` signs with a different key that claims the same key id.
 */
export async function signToken(claims, { forged = false, expiresIn = '1h', issuer = `${fakeAuth.url}/auth/v1` } = {}) {
  const key = forged ? (await generateKeyPair('ES256')).privateKey : fakeAuth.privateKey;
  return new SignJWT({ ...claims, role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience('authenticated')
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

export const shipping = {
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+2348012345678',
  address: '12 Marina Road, Lagos Island',
  city: 'Lagos',
  state: 'Lagos',
  country: 'Nigeria',
};
