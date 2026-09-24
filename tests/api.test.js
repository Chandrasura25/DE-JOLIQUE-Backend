import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import request from 'supertest';
import { setupTestApp, shipping, signToken } from './helpers/setup.js';

let ctx;
let api;

before(async () => {
  ctx = await setupTestApp();
  api = request(ctx.app);
});

after(async () => {
  await ctx?.teardown();
});

describe('health & config', () => {
  test('health and public config respond without secrets', async () => {
    await api.get('/api/health').expect(200);
    const res = await api.get('/api/config').expect(200);
    assert.deepEqual(res.body.config.paymentProviders, { paystack: true, flutterwave: true });
    assert.equal(res.body.config.currency, 'NGN');
    assert.ok(!JSON.stringify(res.body).includes('sk_test'), 'secret key leaked');
  });

  test('unknown API routes return JSON 404', async () => {
    const res = await api.get('/api/nope').expect(404);
    assert.equal(res.body.success, false);
  });
});

describe('authentication (Supabase tokens)', () => {
  test('rejects missing, forged and expired tokens', async () => {
    await api.get('/api/auth/me').expect(401);
    const user = await ctx.createUser();
    const forged = await signToken({ sub: user.id, email: user.email }, { forged: true });
    await api.get('/api/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
    const wrongIssuer = await signToken({ sub: user.id }, { issuer: 'https://evil.example/auth/v1' });
    await api.get('/api/auth/me').set('Authorization', `Bearer ${wrongIssuer}`).expect(401);
    const expired = await signToken({ sub: user.id }, { expiresIn: '-1m' });
    await api.get('/api/auth/me').set('Authorization', `Bearer ${expired}`).expect(401);
  });

  test('returns the profile created by the sign-up trigger', async () => {
    const user = await ctx.createUser({ name: 'Chidi' });
    const res = await api.get('/api/auth/me').set(user.auth).expect(200);
    assert.equal(res.body.user.name, 'Chidi');
    assert.equal(res.body.user.role, 'customer');
    assert.equal(res.body.user.phone, '08012345678');
  });

  test('role in user metadata is ignored by the sign-up trigger', async () => {
    const { rows } = await ctx.db.query(
      `insert into auth.users (email, raw_user_meta_data) values ('sneaky@example.com', '{"name":"S","role":"admin"}') returning id`,
    );
    const profile = await ctx.db.query('select role from public.profiles where id = $1', [rows[0].id]);
    assert.equal(profile.rows[0].role, 'customer');
  });

  test('backfills a missing profile from token claims', async () => {
    const { rows } = await ctx.db.query(`insert into auth.users (email) values ('late@example.com') returning id`);
    await ctx.db.query('delete from public.profiles where id = $1', [rows[0].id]);
    const token = await signToken({ sub: rows[0].id, email: 'late@example.com', user_metadata: { name: 'Late' } });
    const res = await api.get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    assert.equal(res.body.user.name, 'Late');
    assert.equal(res.body.user.role, 'customer');
  });

  test('updates name and phone with validation', async () => {
    const user = await ctx.createUser();
    const res = await api.put('/api/auth/me').set(user.auth).send({ name: 'New Name', phone: '+234 801 111 2222' }).expect(200);
    assert.equal(res.body.user.name, 'New Name');
    await api.put('/api/auth/me').set(user.auth).send({ phone: 'abc' }).expect(400);
  });
});

/** name -> { value, attributes } for every Set-Cookie on a response. */
function setCookies(res) {
  const out = {};
  for (const line of res.headers['set-cookie'] || []) {
    const [pair, ...attrs] = line.split(';').map((p) => p.trim());
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = { value: decodeURIComponent(pair.slice(i + 1)), attrs: attrs.join('; ') };
  }
  return out;
}

const cookieHeader = (jar) =>
  Object.entries(jar)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');

describe('backend sessions (Supabase tokens in httpOnly cookies)', () => {
  test('register starts a cookie session and never returns tokens in the body', async () => {
    const email = `new-${Date.now()}@example.com`;
    const res = await api
      .post('/api/auth/register')
      .send({ name: 'Ngozi Obi', email, phone: '08011112222', password: 'secret123' })
      .expect(201);
    assert.equal(res.body.needsConfirmation, false);
    assert.equal(res.body.user.name, 'Ngozi Obi');
    assert.doesNotMatch(JSON.stringify(res.body), /access_token|refresh_token|eyJ/);

    const cookies = setCookies(res);
    for (const name of ['jq_access', 'jq_refresh']) {
      assert.ok(cookies[name]?.value, `${name} set`);
      assert.match(cookies[name].attrs, /HttpOnly/);
      assert.match(cookies[name].attrs, /Path=\/api/);
      assert.match(cookies[name].attrs, /SameSite=Lax/);
    }
    const me = await api.get('/api/auth/me').set('Cookie', cookieHeader({ jq_access: cookies.jq_access.value })).expect(200);
    assert.equal(me.body.user.email, email);

    await api.post('/api/auth/register').send({ name: 'Again', email, password: 'secret123' }).expect(400);
  });

  test('login checks the password with Supabase and sets the session', async () => {
    const user = await ctx.createUser({ name: 'Emeka', password: 'hunter22x' });
    const bad = await api.post('/api/auth/login').send({ email: user.email, password: 'wrong-pass1' }).expect(400);
    assert.equal(bad.body.message, 'Invalid email or password.');
    assert.equal(setCookies(bad).jq_access, undefined);

    const res = await api.post('/api/auth/login').send({ email: user.email.toUpperCase(), password: 'hunter22x' }).expect(200);
    assert.equal(res.body.user.name, 'Emeka');
    const { jq_access } = setCookies(res);
    await api.get('/api/auth/me').set('Cookie', cookieHeader({ jq_access: jq_access.value })).expect(200);
  });

  test('an expired access cookie is refreshed transparently and the refresh token rotates', async () => {
    const user = await ctx.createUser();
    const session = await ctx.auth.issueSession(user.id);
    const expired = await signToken({ sub: user.id, email: user.email }, { expiresIn: '-1m' });

    const res = await api
      .get('/api/auth/me')
      .set('Cookie', cookieHeader({ jq_access: expired, jq_refresh: session.refresh_token }))
      .expect(200);
    assert.equal(res.body.user.id, user.id);
    const cookies = setCookies(res);
    assert.notEqual(cookies.jq_access.value, expired);
    assert.notEqual(cookies.jq_refresh.value, session.refresh_token);

    // The old refresh token was consumed: reusing it ends the session and clears the cookies.
    const reused = await api.get('/api/auth/me').set('Cookie', cookieHeader({ jq_refresh: session.refresh_token })).expect(401);
    assert.match(setCookies(reused).jq_refresh.attrs, /Expires=Thu, 01 Jan 1970/);
  });

  test('logout revokes the Supabase session and clears the cookies', async () => {
    const user = await ctx.createUser();
    const session = await ctx.auth.issueSession(user.id);
    const res = await api
      .post('/api/auth/logout')
      .set('Cookie', cookieHeader({ jq_access: session.access_token, jq_refresh: session.refresh_token }))
      .expect(200);
    assert.deepEqual(ctx.auth.state.revoked.at(-1), { token: session.access_token, scope: 'local' });
    assert.match(setCookies(res).jq_access.attrs, /Expires=Thu, 01 Jan 1970/);
    await api.post('/api/auth/logout').expect(200);
  });

  test('state-changing requests from other sites are refused', async () => {
    const user = await ctx.createUser();
    await api.put('/api/auth/me').set(user.auth).set('Origin', 'https://evil.example').send({ name: 'Hacked' }).expect(403);
    await api.put('/api/auth/me').set(user.auth).set('Origin', 'http://localhost:5173').send({ name: 'Fine Name' }).expect(200);
  });

  test('Google sign-in: redirect to Supabase, then the callback exchanges the code with the PKCE verifier', async () => {
    const providers = await api.get('/api/auth/providers').expect(200);
    assert.deepEqual(providers.body.providers, { email: true, google: true });

    const start = await api.get('/api/auth/google').query({ next: '/checkout' }).expect(302);
    const location = new URL(start.headers.location);
    assert.equal(location.origin + location.pathname, `${ctx.auth.url}/auth/v1/authorize`);
    assert.equal(location.searchParams.get('provider'), 'google');
    assert.match(location.searchParams.get('redirect_to'), /^http:\/\/localhost:5000\/api\/auth\/callback/);
    const flow = setCookies(start).jq_auth_flow;
    assert.match(flow.attrs, /HttpOnly/);

    const user = await ctx.createUser({ name: 'Google User' });
    const code = ctx.auth.completeFlow(user.id, { challenge: location.searchParams.get('code_challenge') });
    const done = await api.get('/api/auth/callback').query({ code }).set('Cookie', cookieHeader({ jq_auth_flow: flow.value })).expect(302);
    assert.equal(done.headers.location, 'http://localhost:5173/checkout');
    const cookies = setCookies(done);
    const me = await api.get('/api/auth/me').set('Cookie', cookieHeader({ jq_access: cookies.jq_access.value })).expect(200);
    assert.equal(me.body.user.name, 'Google User');
  });

  test('callback failures land on the login page with a reason', async () => {
    const cancelled = await api.get('/api/auth/callback').query({ error: 'access_denied' }).expect(302);
    assert.equal(cancelled.headers.location, 'http://localhost:5173/login?auth=cancelled');
    const otherBrowser = await api.get('/api/auth/callback').query({ code: 'abc' }).expect(302);
    assert.equal(otherBrowser.headers.location, 'http://localhost:5173/login?auth=verified');

    const start = await api.get('/api/auth/google').expect(302);
    const user = await ctx.createUser();
    const code = ctx.auth.completeFlow(user.id, { challenge: 'not-the-right-challenge' });
    const bad = await api
      .get('/api/auth/callback')
      .query({ code })
      .set('Cookie', cookieHeader({ jq_auth_flow: setCookies(start).jq_auth_flow.value }))
      .expect(302);
    assert.equal(bad.headers.location, 'http://localhost:5173/login?auth=expired');
    assert.equal(setCookies(bad).jq_access, undefined);
  });

  test('open redirects through ?next are ignored', async () => {
    const start = await api.get('/api/auth/google').query({ next: '//evil.example/x' }).expect(302);
    const user = await ctx.createUser();
    const code = ctx.auth.completeFlow(user.id, { challenge: new URL(start.headers.location).searchParams.get('code_challenge') });
    const done = await api
      .get('/api/auth/callback')
      .query({ code })
      .set('Cookie', cookieHeader({ jq_auth_flow: setCookies(start).jq_auth_flow.value }))
      .expect(302);
    assert.equal(done.headers.location, 'http://localhost:5173/account');
  });

  test('email confirmation: sign-up without a session, then the emailed link signs the user in', async () => {
    ctx.auth.state.autoconfirm = false;
    try {
      const email = `confirm-${Date.now()}@example.com`;
      const res = await api.post('/api/auth/register').send({ name: 'Confirm Me', email, password: 'secret123', next: '/cart' }).expect(201);
      assert.equal(res.body.needsConfirmation, true);
      assert.equal(setCookies(res).jq_access, undefined);
      assert.match(ctx.auth.state.pendingChallenges.at(-1).redirectTo, /\/api\/auth\/callback/);

      const { rows } = await ctx.db.query('select id from auth.users where email = $1', [email]);
      const code = ctx.auth.completeFlow(rows[0].id, { method: 'email/signup' });
      const done = await api
        .get('/api/auth/callback')
        .query({ code })
        .set('Cookie', cookieHeader({ jq_auth_flow: setCookies(res).jq_auth_flow.value }))
        .expect(302);
      assert.equal(done.headers.location, 'http://localhost:5173/cart');

      const dup = await api.post('/api/auth/register').send({ name: 'Dup', email, password: 'secret123' }).expect(409);
      assert.match(dup.body.message, /already exists/);
    } finally {
      ctx.auth.state.autoconfirm = true;
    }
  });

  test('password reset only works from a recovery-link session', async () => {
    const user = await ctx.createUser({ password: 'oldpass123' });
    const normal = await ctx.auth.issueSession(user.id);
    await api
      .post('/api/auth/reset-password')
      .set('Cookie', cookieHeader({ jq_access: normal.access_token }))
      .send({ password: 'newpass123' })
      .expect(403);

    const forgot = await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200);
    const code = ctx.auth.completeFlow(user.id, { method: 'recovery' });
    const back = await api
      .get('/api/auth/callback')
      .query({ code })
      .set('Cookie', cookieHeader({ jq_auth_flow: setCookies(forgot).jq_auth_flow.value }))
      .expect(302);
    assert.equal(back.headers.location, 'http://localhost:5173/reset-password');

    await api
      .post('/api/auth/reset-password')
      .set('Cookie', cookieHeader({ jq_access: setCookies(back).jq_access.value }))
      .send({ password: 'short' })
      .expect(400);
    await api
      .post('/api/auth/reset-password')
      .set('Cookie', cookieHeader({ jq_access: setCookies(back).jq_access.value }))
      .send({ password: 'newpass123' })
      .expect(200);
    assert.deepEqual(ctx.auth.state.passwordUpdates.at(-1), { id: user.id, password: 'newpass123' });
  });
});

describe('storefront products', () => {
  let category;

  before(async () => {
    category = await ctx.createCategory('Gadgets');
    await ctx.createProduct({ name: 'Alpha Speaker', price: 5000, stock: 3, categoryId: category.id, featured: true });
    await ctx.createProduct({ name: 'Beta Speaker', price: 15000, stock: 0, categoryId: category.id });
    await ctx.createProduct({ name: 'Gamma Lamp', price: 9000, stock: 50 });
    await ctx.createProduct({ name: 'Hidden Speaker', price: 100, stock: 5, isActive: false });
  });

  test('searches, filters, sorts and paginates', async () => {
    let res = await api.get('/api/products').query({ search: 'speaker' }).expect(200);
    assert.deepEqual(res.body.products.map((p) => p.name).sort(), ['Alpha Speaker', 'Beta Speaker']);

    res = await api.get('/api/products').query({ category: 'gadgets', sort: 'price_desc' }).expect(200);
    assert.deepEqual(res.body.products.map((p) => p.name), ['Beta Speaker', 'Alpha Speaker']);

    res = await api.get('/api/products').query({ minPrice: 6000, maxPrice: 10000 }).expect(200);
    assert.ok(res.body.products.every((p) => p.price >= 6000 && p.price <= 10000));

    res = await api.get('/api/products').query({ limit: 1, page: 2, search: 'speaker', sort: 'price_asc' }).expect(200);
    assert.equal(res.body.products[0].name, 'Beta Speaker');
    assert.equal(res.body.pagination.pages, 2);

    res = await api.get('/api/products').query({ featured: 'true' }).expect(200);
    assert.ok(res.body.products.every((p) => p.featured));

    await api.get('/api/products').query({ minPrice: 10, maxPrice: 5 }).expect(400);
  });

  test('search input is treated literally (no SQL/LIKE injection)', async () => {
    const res = await api.get('/api/products').query({ search: "%' or 1=1 --" }).expect(200);
    assert.equal(res.body.products.length, 0);
    await api.get('/api/products').query({ sort: 'price; drop table products' }).expect(400);
  });

  test('hidden products are not visible to customers', async () => {
    const res = await api.get('/api/products').query({ search: 'hidden' }).expect(200);
    assert.equal(res.body.products.length, 0);
    await api.get('/api/products/hidden-speaker').expect(404);
  });

  test('gets a product by slug and reports stock state', async () => {
    const res = await api.get('/api/products/alpha-speaker').expect(200);
    assert.equal(res.body.product.inStock, true);
    assert.equal(res.body.product.lowStock, true);
    assert.equal(res.body.product.category.slug, 'gadgets');
    const byId = await api.get(`/api/products/${res.body.product.id}`).expect(200);
    assert.equal(byId.body.product.slug, 'alpha-speaker');
  });

  test('lists categories with product counts', async () => {
    const res = await api.get('/api/categories').expect(200);
    const gadgets = res.body.categories.find((c) => c.slug === 'gadgets');
    assert.equal(gadgets.productCount, 2);
  });

  test('cart validation returns live price and stock', async () => {
    const alpha = (await api.get('/api/products/alpha-speaker')).body.product;
    const beta = (await api.get('/api/products/beta-speaker')).body.product;
    const res = await api
      .post('/api/cart/validate')
      .send({ items: [{ productId: alpha.id, quantity: 10 }, { productId: beta.id, quantity: 1 }] })
      .expect(200);
    assert.equal(res.body.items[0].maxQuantity, 3);
    assert.match(res.body.items[0].message, /Only 3 left/);
    assert.equal(res.body.items[1].available, false);
  });
});

describe('admin authorization', () => {
  test('customers cannot use admin APIs', async () => {
    const customer = await ctx.createUser();
    await api.get('/api/admin/stats').set(customer.auth).expect(403);
    await api.get('/api/admin/orders').set(customer.auth).expect(403);
    await api
      .post('/api/products')
      .set(customer.auth)
      .send({ name: 'X', description: 'xxxxxxxxxxxx', price: 1, stock: 1 })
      .expect(403);
    await api.get('/api/admin/stats').expect(401);
  });

  test('admins with a pending password change are blocked from admin APIs', async () => {
    const admin = await ctx.createUser({ role: 'admin', mustChangePassword: true });
    const res = await api.get('/api/admin/stats').set(admin.auth).expect(403);
    assert.equal(res.body.code, 'PASSWORD_CHANGE_REQUIRED');
    // ...but can still read their own profile to be redirected.
    await api.get('/api/auth/me').set(admin.auth).expect(200);
  });

  test('demoting an admin takes effect immediately (role read from DB each request)', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    await api.get('/api/admin/stats').set(admin.auth).expect(200);
    await ctx.db.query(`update public.profiles set role = 'customer' where id = $1`, [admin.id]);
    await api.get('/api/admin/stats').set(admin.auth).expect(403);
  });
});

describe('admin product & category management', () => {
  let admin;
  before(async () => {
    admin = await ctx.createUser({ role: 'admin' });
  });

  test('creates, edits and deletes a product', async () => {
    const category = (await api.post('/api/admin/categories').set(admin.auth).send({ name: 'Kitchen' }).expect(201)).body
      .category;

    const created = await api
      .post('/api/products')
      .set(admin.auth)
      .send({
        name: 'Chef Knife',
        description: 'A very sharp chef knife.',
        price: 12000,
        stock: 4,
        categoryId: category.id,
        featured: true,
        images: [{ url: 'https://example.com/knife.jpg', provider: 'external' }],
      })
      .expect(201);
    const product = created.body.product;
    assert.equal(product.slug, 'chef-knife');
    assert.equal(product.category.name, 'Kitchen');

    const updated = await api
      .put(`/api/products/${product.id}`)
      .set(admin.auth)
      .send({ price: 13500, stock: 9, featured: false, isActive: false })
      .expect(200);
    assert.equal(updated.body.product.price, 13500);
    assert.equal(updated.body.product.isActive, false);
    await api.get('/api/products/chef-knife').expect(404); // hidden now

    const list = await api.get('/api/admin/products').set(admin.auth).query({ status: 'hidden', search: 'chef' }).expect(200);
    assert.equal(list.body.products.length, 1);

    await api.delete(`/api/products/${product.id}`).set(admin.auth).expect(200);
    await api.get(`/api/admin/products/${product.id}`).set(admin.auth).expect(404);
  });

  test('rejects invalid product data', async () => {
    const bad = await api
      .post('/api/products')
      .set(admin.auth)
      .send({ name: 'B', description: 'short', price: -5, stock: -1 })
      .expect(400);
    assert.equal(bad.body.success, false);
    assert.ok(bad.body.details.length >= 3);
  });

  test('filters low-stock products', async () => {
    await ctx.createProduct({ name: 'Nearly Gone', stock: 2 });
    const res = await api.get('/api/admin/products').set(admin.auth).query({ stock: 'low' }).expect(200);
    assert.ok(res.body.products.some((p) => p.name === 'Nearly Gone'));
    assert.ok(res.body.products.every((p) => p.stock > 0 && p.stock <= 5));
  });

  test('prevents duplicate category names', async () => {
    await api.post('/api/admin/categories').set(admin.auth).send({ name: 'Garden' }).expect(201);
    await api.post('/api/admin/categories').set(admin.auth).send({ name: 'garden' }).expect(409);
  });

  test('uploads real images and rejects disguised files', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const ok = await api
      .post('/api/admin/uploads')
      .set(admin.auth)
      .attach('images', png, { filename: 'dot.png', contentType: 'image/png' })
      .expect(201);
    const [image] = ok.body.images;
    assert.equal(image.provider, 'local');
    assert.match(image.url, /\/uploads\/products\/.+\.png$/);
    await api.get(new URL(image.url).pathname).expect(200);

    await api
      .post('/api/admin/uploads')
      .set(admin.auth)
      .attach('images', Buffer.from('<?php echo 1; ?>'), { filename: 'evil.png', contentType: 'image/png' })
      .expect(400);

    await fs.rm(new URL(`../uploads/${image.key}`, import.meta.url), { force: true });
  });
});

describe('orders', () => {
  let customer;
  let product;

  before(async () => {
    customer = await ctx.createUser();
    product = await ctx.createProduct({ name: 'Order Test Mug', price: 2500, stock: 5 });
  });

  test('prices come from the database, not the client', async () => {
    const res = await api
      .post('/api/orders')
      .set(customer.auth)
      .send({
        items: [{ productId: product.id, quantity: 2, price: 1 }],
        shippingAddress: shipping,
        paymentMethod: 'paystack',
        totalAmount: 1,
      })
      .expect(201);
    const { order } = res.body;
    assert.equal(order.subtotal, 5000);
    assert.equal(order.shippingFee, 1500);
    assert.equal(order.totalAmount, 6500);
    assert.equal(order.orderStatus, 'pending');
    assert.equal(order.paymentStatus, 'pending');
    assert.equal(order.items[0].price, 2500);
    assert.match(order.orderNumber, /^JQ-\d{6}$/);

    // Creating an order does not touch stock.
    const { rows } = await ctx.db.query('select stock from public.products where id = $1', [product.id]);
    assert.equal(rows[0].stock, 5);
  });

  test('requires login, a non-empty cart and valid shipping details', async () => {
    await api.post('/api/orders').send({}).expect(401);
    const empty = await api
      .post('/api/orders')
      .set(customer.auth)
      .send({ items: [], shippingAddress: shipping, paymentMethod: 'paystack' })
      .expect(400);
    assert.match(empty.body.message, /cart is empty/);
    await api
      .post('/api/orders')
      .set(customer.auth)
      .send({ items: [{ productId: product.id, quantity: 1 }], shippingAddress: { ...shipping, email: 'nope' }, paymentMethod: 'paystack' })
      .expect(400);
    await api
      .post('/api/orders')
      .set(customer.auth)
      .send({ items: [{ productId: product.id, quantity: 1 }], shippingAddress: shipping, paymentMethod: 'bitcoin' })
      .expect(400);
  });

  test('refuses more than the available stock', async () => {
    const res = await api
      .post('/api/orders')
      .set(customer.auth)
      .send({ items: [{ productId: product.id, quantity: 6 }], shippingAddress: shipping, paymentMethod: 'paystack' })
      .expect(409);
    assert.match(res.body.message, /Only 5 of "Order Test Mug" left/);

    const soldOut = await ctx.createProduct({ name: 'Sold Out Thing', stock: 0 });
    const res2 = await api
      .post('/api/orders')
      .set(customer.auth)
      .send({ items: [{ productId: soldOut.id, quantity: 1 }], shippingAddress: shipping, paymentMethod: 'paystack' })
      .expect(409);
    assert.match(res2.body.message, /out of stock/);
  });

  test('customers only see their own orders', async () => {
    const other = await ctx.createUser();
    const created = await api
      .post('/api/orders')
      .set(customer.auth)
      .send({ items: [{ productId: product.id, quantity: 1 }], shippingAddress: shipping, paymentMethod: 'flutterwave' })
      .expect(201);
    const orderId = created.body.order.id;

    await api.get(`/api/orders/${orderId}`).set(customer.auth).expect(200);
    await api.get(`/api/orders/${orderId}`).set(other.auth).expect(404);

    const mine = await api.get('/api/orders/my-orders').set(customer.auth).expect(200);
    assert.ok(mine.body.orders.some((o) => o.id === orderId));
    const theirs = await api.get('/api/orders/my-orders').set(other.auth).expect(200);
    assert.equal(theirs.body.orders.length, 0);
  });

  test('unpaid orders cannot be fulfilled, but can be cancelled by the customer', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const created = await api
      .post('/api/orders')
      .set(customer.auth)
      .send({ items: [{ productId: product.id, quantity: 1 }], shippingAddress: shipping, paymentMethod: 'paystack' })
      .expect(201);
    const orderId = created.body.order.id;

    const res = await api.put(`/api/admin/orders/${orderId}/status`).set(admin.auth).send({ status: 'processing' }).expect(400);
    assert.match(res.body.message, /Only paid orders/);

    const cancelled = await api.post(`/api/orders/${orderId}/cancel`).set(customer.auth).expect(200);
    assert.equal(cancelled.body.order.orderStatus, 'cancelled');
    await api.post(`/api/orders/${orderId}/cancel`).set(customer.auth).expect(400);
  });

  test('admin can list and filter orders', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const all = await api.get('/api/admin/orders').set(admin.auth).expect(200);
    assert.ok(all.body.orders.length >= 3);
    const cancelled = await api.get('/api/admin/orders').set(admin.auth).query({ status: 'cancelled' }).expect(200);
    assert.ok(cancelled.body.orders.every((o) => o.orderStatus === 'cancelled'));
    const pendingPayment = await api.get('/api/admin/orders').set(admin.auth).query({ status: 'failed' }).expect(200);
    assert.ok(pendingPayment.body.orders.every((o) => o.paymentStatus === 'failed'));
    await api.get('/api/admin/orders').set(admin.auth).query({ status: 'bogus' }).expect(400);
  });
});

describe('admin user management', () => {
  test('lists users with role, providers, order count and last sign-in; customers are refused', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const customer = await ctx.createUser({ name: 'Zainab Listme', password: 'loginpass1' });
    await api.get('/api/admin/users').set(customer.auth).expect(403);

    let res = await api.get('/api/admin/users').set(admin.auth).query({ search: 'Zainab Listme' }).expect(200);
    assert.equal(res.body.users.length, 1);
    assert.equal(res.body.users[0].lastSignInAt, null);
    assert.deepEqual(res.body.users[0].providers, ['email']);
    assert.equal(res.body.users[0].orderCount, 0);

    await api.post('/api/auth/login').send({ email: customer.email, password: 'loginpass1' }).expect(200);
    res = await api.get('/api/admin/users').set(admin.auth).query({ search: customer.email }).expect(200);
    assert.ok(Date.now() - new Date(res.body.users[0].lastSignInAt).getTime() < 60_000, 'last sign-in recorded');

    const admins = await api.get('/api/admin/users').set(admin.auth).query({ role: 'admin' }).expect(200);
    assert.deepEqual(admins.body.users.map((u) => u.id), [admin.id]);
    await api.get('/api/admin/users').set(admin.auth).query({ role: 'owner' }).expect(400);
  });

  test('the database allows only one admin', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const other = await ctx.createUser();
    await assert.rejects(
      ctx.db.query(`update public.profiles set role = 'admin' where id = $1`, [other.id]),
      /profiles_single_admin_idx/,
    );
    const { rows } = await ctx.db.query(`select id from public.profiles where role = 'admin'`);
    assert.deepEqual(rows.map((r) => r.id), [admin.id]);
  });

  test('create-admin refuses a second admin unless the role is handed over with replace', async () => {
    const { upsertAdminUser } = await import('../src/services/authService.js');
    const current = await ctx.createUser({ role: 'admin' });
    const email = `owner-${Date.now()}@example.com`;

    await assert.rejects(upsertAdminUser({ email, password: 'Str0ngPass1', name: 'New Owner' }), (err) => {
      assert.equal(err.code, 'ADMIN_EXISTS');
      assert.equal(err.adminEmail, current.email);
      return true;
    });
    // Refused before Supabase Auth was touched: no stray account.
    assert.equal((await ctx.db.query('select 1 from auth.users where email = $1', [email])).rowCount, 0);

    // Re-running for the current admin is fine.
    await upsertAdminUser({ email: current.email.toUpperCase(), password: 'Str0ngPass1', name: 'Same' });

    const { profile, replaced } = await upsertAdminUser({ email, password: 'Str0ngPass1', name: 'New Owner', replace: true });
    assert.equal(profile.role, 'admin');
    assert.equal(profile.must_change_password, true);
    assert.equal(replaced.email, current.email);
    const roles = await ctx.db.query('select id, role from public.profiles where id = any($1)', [[current.id, profile.id]]);
    assert.deepEqual(Object.fromEntries(roles.rows.map((r) => [r.id, r.role])), { [current.id]: 'customer', [profile.id]: 'admin' });
  });

  test('deleting a user removes the account but keeps their orders; their token stops working', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const customer = await ctx.createUser();
    const product = await ctx.createProduct({ stock: 5 });
    const { body } = await api
      .post('/api/orders')
      .set(customer.auth)
      .send({ items: [{ productId: product.id, quantity: 1 }], shippingAddress: shipping, paymentMethod: 'paystack' })
      .expect(201);

    const refused = await api.delete(`/api/admin/users/${admin.id}`).set(admin.auth).expect(400);
    assert.equal(refused.body.message, 'The admin account can’t be deleted.');
    const res = await api.delete(`/api/admin/users/${customer.id}`).set(admin.auth).expect(200);
    assert.match(res.body.message, new RegExp(customer.email));

    const gone = await ctx.db.query('select 1 from public.profiles where id = $1 union all select 1 from auth.users where id = $1', [customer.id]);
    assert.equal(gone.rowCount, 0);
    const order = await api.get(`/api/admin/orders/${body.order.id}`).set(admin.auth).expect(200);
    assert.equal(order.body.order.shippingAddress.fullName, shipping.fullName);

    // Still-unexpired access token of the deleted account must not resurrect the profile.
    await api.get('/api/auth/me').set(customer.auth).expect(401);
    await api.delete(`/api/admin/users/${customer.id}`).set(admin.auth).expect(404);
  });
});
