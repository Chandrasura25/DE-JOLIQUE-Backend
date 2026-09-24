import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { FLW_HASH, setupTestApp, shipping } from './helpers/setup.js';

// Only the outbound HTTP calls to Paystack/Flutterwave are replaced here. Everything
// else — verification logic, locking, stock updates, idempotency — is the real code.
let ctx;
let api;
let providerState; // reference/txId -> what the "provider" reports
let refunds;
let initializeCalls;

before(async () => {
  ctx = await setupTestApp();
  api = request(ctx.app);
  const { paystack, flutterwave } = ctx.gateways;

  paystack.initialize = async (args) => {
    initializeCalls.push({ provider: 'paystack', ...args });
    return { authorizationUrl: `https://checkout.paystack.test/${args.reference}` };
  };
  paystack.verify = async (reference) => {
    const s = providerState.get(reference);
    if (!s) {
      const { GatewayError } = await import('../src/services/gateways/http.js');
      throw new GatewayError('Paystack', 'Transaction reference not found', 400);
    }
    return { reference, transactionId: '9001', channel: 'card', gatewayResponse: s.status, raw: {}, paidAt: null, ...s };
  };
  paystack.refund = async (args) => {
    refunds.push({ provider: 'paystack', ...args });
  };

  flutterwave.initialize = async (args) => {
    initializeCalls.push({ provider: 'flutterwave', ...args });
    return { authorizationUrl: `https://checkout.flutterwave.test/${args.reference}` };
  };
  flutterwave.verify = async (transactionId) => {
    const s = providerState.get(`flw:${transactionId}`);
    return { transactionId, channel: 'card', gatewayResponse: 'Approved', raw: {}, paidAt: null, ...s };
  };
  flutterwave.verifyByReference = async (reference) => {
    const s = providerState.get(reference);
    if (!s) {
      const { GatewayError } = await import('../src/services/gateways/http.js');
      throw new GatewayError('Flutterwave', 'No transaction was found for this id', 400);
    }
    return { reference, transactionId: s.transactionId, channel: 'card', raw: {}, ...s };
  };
  flutterwave.refund = async (args) => {
    refunds.push({ provider: 'flutterwave', ...args });
  };
});

beforeEach(() => {
  providerState = new Map();
  refunds = [];
  initializeCalls = [];
});

after(async () => {
  await ctx?.teardown();
});

async function stockOf(productId) {
  const { rows } = await ctx.db.query('select stock from public.products where id = $1', [productId]);
  return rows[0].stock;
}

async function placeOrder(user, items, paymentMethod = 'paystack') {
  const res = await api
    .post('/api/orders')
    .set(user.auth)
    .send({ items, shippingAddress: shipping, paymentMethod })
    .expect(201);
  return res.body.order;
}

async function startPayment(user, orderId, provider = 'paystack') {
  const res = await api.post(`/api/payments/${provider}/initialize`).set(user.auth).send({ orderId }).expect(200);
  return res.body;
}

const paystackSuccess = (amount) => ({ status: 'success', providerStatus: 'success', amount, currency: 'NGN' });

describe('Paystack', () => {
  test('initialize uses the stored order total and a fresh reference', async () => {
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 4000, stock: 5 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 2 }]);

    const init = await startPayment(user, order.id);
    assert.match(init.authorizationUrl, /^https:\/\/checkout\.paystack\.test\//);
    assert.equal(initializeCalls[0].amount, 9500); // 2 x 4000 + 1500 delivery
    assert.equal(initializeCalls[0].currency, 'NGN');
    assert.match(initializeCalls[0].callbackUrl, /\/payment\/callback\?provider=paystack&order=/);

    const second = await startPayment(user, order.id);
    assert.notEqual(second.reference, init.reference);
  });

  test('successful verification marks the order paid and deducts stock once', async () => {
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 3000, stock: 5 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 2 }]);
    const { reference } = await startPayment(user, order.id);

    // Frontend claims success before paying — the backend asks Paystack and refuses.
    const early = await api.get(`/api/payments/paystack/verify/${reference}`).set(user.auth).expect(200);
    assert.equal(early.body.state, 'pending');
    assert.equal(await stockOf(product.id), 5);

    providerState.set(reference, paystackSuccess(7500));
    const res = await api.get(`/api/payments/paystack/verify/${reference}`).set(user.auth).expect(200);
    assert.equal(res.body.state, 'paid');
    assert.equal(res.body.order.paymentStatus, 'paid');
    assert.equal(res.body.order.orderStatus, 'pending');
    assert.equal(await stockOf(product.id), 3);

    // Replays (refresh, webhook, callback) are no-ops.
    for (let i = 0; i < 3; i += 1) {
      const again = await api.get(`/api/payments/paystack/verify/${reference}`).set(user.auth).expect(200);
      assert.equal(again.body.state, 'paid');
    }
    assert.equal(await stockOf(product.id), 3);

    const payment = await ctx.db.query('select * from public.payments where reference = $1', [reference]);
    assert.equal(payment.rows[0].status, 'success');
    assert.equal(payment.rows[0].amount_paid, 7500);
  });

  test('concurrent verifications of the same payment deduct stock exactly once', async () => {
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 1000, stock: 10 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 3 }]);
    const { reference } = await startPayment(user, order.id);
    providerState.set(reference, paystackSuccess(4500));

    const results = await Promise.all(
      Array.from({ length: 8 }, () => api.get(`/api/payments/paystack/verify/${reference}`).set(user.auth)),
    );
    assert.ok(results.every((r) => r.status === 200 && r.body.state === 'paid'));
    assert.equal(await stockOf(product.id), 7);
  });

  test('amount or currency mismatch is not accepted as paid', async () => {
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 50000, stock: 2 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 1 }]);
    const { reference } = await startPayment(user, order.id);

    providerState.set(reference, paystackSuccess(100)); // paid ₦100 for a ₦51,500 order
    const res = await api.get(`/api/payments/paystack/verify/${reference}`).set(user.auth).expect(200);
    assert.equal(res.body.state, 'failed');
    assert.equal(res.body.order.paymentStatus, 'failed');
    assert.equal(await stockOf(product.id), 2);

    const { reference: ref2 } = await startPayment(user, order.id);
    providerState.set(ref2, { ...paystackSuccess(51500), currency: 'USD' });
    const res2 = await api.get(`/api/payments/paystack/verify/${ref2}`).set(user.auth).expect(200);
    assert.equal(res2.body.state, 'failed');
    assert.equal(await stockOf(product.id), 2);
  });

  test('failed payments keep stock and allow a retry', async () => {
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 2000, stock: 4 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 1 }]);
    const { reference } = await startPayment(user, order.id);

    providerState.set(reference, { status: 'failed', providerStatus: 'failed', amount: 3500, currency: 'NGN' });
    const failed = await api.get(`/api/payments/paystack/verify/${reference}`).set(user.auth).expect(200);
    assert.equal(failed.body.state, 'failed');
    assert.equal(failed.body.message, 'Payment failed. Please try again.');
    assert.equal(failed.body.order.paymentStatus, 'failed');
    assert.equal(await stockOf(product.id), 4);

    const retry = await startPayment(user, order.id, 'flutterwave');
    const orderNow = await api.get(`/api/orders/${order.id}`).set(user.auth).expect(200);
    assert.equal(orderNow.body.order.paymentStatus, 'pending');
    assert.equal(orderNow.body.order.paymentMethod, 'flutterwave');
    assert.equal(orderNow.body.order.paymentReference, retry.reference);
  });

  test('another customer cannot verify or pay my order', async () => {
    const user = await ctx.createUser();
    const intruder = await ctx.createUser();
    const product = await ctx.createProduct({ stock: 3 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 1 }]);
    const { reference } = await startPayment(user, order.id);

    await api.get(`/api/payments/paystack/verify/${reference}`).set(intruder.auth).expect(404);
    await api.post('/api/payments/paystack/initialize').set(intruder.auth).send({ orderId: order.id }).expect(404);
  });

  test('cannot pay twice or pay for a sold-out order', async () => {
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 1000, stock: 1 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 1 }]);
    const { reference } = await startPayment(user, order.id);
    providerState.set(reference, paystackSuccess(2500));
    await api.get(`/api/payments/paystack/verify/${reference}`).set(user.auth).expect(200);

    const again = await api.post('/api/payments/paystack/initialize').set(user.auth).send({ orderId: order.id }).expect(409);
    assert.match(again.body.message, /already been paid/);

    const product2 = await ctx.createProduct({ price: 1000, stock: 1 });
    const order2 = await placeOrder(user, [{ productId: product2.id, quantity: 1 }]);
    await ctx.db.query('update public.products set stock = 0 where id = $1', [product2.id]);
    const soldOut = await api.post('/api/payments/paystack/initialize').set(user.auth).send({ orderId: order2.id }).expect(409);
    assert.match(soldOut.body.message, /out of stock/);
  });
});

describe('inventory under concurrency', () => {
  test('two customers paying for the last unit: one wins, the other is refunded', async () => {
    const product = await ctx.createProduct({ name: 'Last One', price: 10000, stock: 1 });
    const alice = await ctx.createUser({ name: 'Alice' });
    const bob = await ctx.createUser({ name: 'Bob' });

    // Both check out while one unit is still available.
    const orderA = await placeOrder(alice, [{ productId: product.id, quantity: 1 }]);
    const orderB = await placeOrder(bob, [{ productId: product.id, quantity: 1 }]);
    const payA = await startPayment(alice, orderA.id);
    const payB = await startPayment(bob, orderB.id);
    providerState.set(payA.reference, paystackSuccess(11500));
    providerState.set(payB.reference, paystackSuccess(11500));

    const [resA, resB] = await Promise.all([
      api.get(`/api/payments/paystack/verify/${payA.reference}`).set(alice.auth),
      api.get(`/api/payments/paystack/verify/${payB.reference}`).set(bob.auth),
    ]);

    const states = [resA.body.state, resB.body.state].sort();
    assert.deepEqual(states, ['paid', 'refunded']);
    assert.equal(await stockOf(product.id), 0);
    assert.equal(refunds.length, 1);

    const loser = resA.body.state === 'refunded' ? resA : resB;
    assert.equal(loser.body.order.orderStatus, 'cancelled');
    assert.equal(loser.body.order.paymentStatus, 'refunded');
    assert.match(loser.body.message, /sold out/);
  });

  test('a multi-item order commits all stock or none', async () => {
    const plenty = await ctx.createProduct({ price: 100, stock: 10 });
    const scarce = await ctx.createProduct({ price: 100, stock: 1 });
    const user = await ctx.createUser();
    const order = await placeOrder(user, [
      { productId: plenty.id, quantity: 2 },
      { productId: scarce.id, quantity: 1 },
    ]);
    const { reference } = await startPayment(user, order.id);
    await ctx.db.query('update public.products set stock = 0 where id = $1', [scarce.id]); // sold elsewhere meanwhile
    providerState.set(reference, paystackSuccess(1800));

    const res = await api.get(`/api/payments/paystack/verify/${reference}`).set(user.auth).expect(200);
    assert.equal(res.body.state, 'refunded');
    assert.equal(await stockOf(plenty.id), 10); // untouched — rolled back to the savepoint
    assert.equal(await stockOf(scarce.id), 0);
  });

  test('stock can never go negative at the database level', async () => {
    const product = await ctx.createProduct({ stock: 1 });
    await assert.rejects(ctx.db.query('update public.products set stock = stock - 2 where id = $1', [product.id]), /check/i);
  });
});

describe('webhooks', () => {
  test('Paystack webhook requires a valid signature and is idempotent', async () => {
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 5000, stock: 5 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 1 }]);
    const { reference } = await startPayment(user, order.id);
    providerState.set(reference, paystackSuccess(6500));

    const body = JSON.stringify({ event: 'charge.success', data: { reference, amount: 650000 } });
    await api
      .post('/api/payments/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'forged')
      .send(body)
      .expect(401);
    assert.equal(await stockOf(product.id), 5);

    const signature = crypto.createHmac('sha512', 'sk_test_paystack').update(body).digest('hex');
    for (let i = 0; i < 3; i += 1) {
      await api
        .post('/api/payments/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', signature)
        .send(body)
        .expect(200);
    }
    assert.equal(await stockOf(product.id), 4);
    const orderNow = await api.get(`/api/orders/${order.id}`).set(user.auth).expect(200);
    assert.equal(orderNow.body.order.paymentStatus, 'paid');
  });

  test('Paystack webhook for an unknown reference is acknowledged and ignored', async () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'NOT-OURS-123' } });
    const signature = crypto.createHmac('sha512', 'sk_test_paystack').update(body).digest('hex');
    await api
      .post('/api/payments/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(body)
      .expect(200);
  });

  test('Flutterwave webhook requires the secret hash and re-verifies with the API', async () => {
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 2000, stock: 3 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 1 }], 'flutterwave');
    const { reference } = await startPayment(user, order.id, 'flutterwave');

    // The webhook body claims success, but the API says it failed: the API wins.
    providerState.set('flw:555', { status: 'failed', providerStatus: 'failed', reference, amount: 3500, currency: 'NGN' });
    const payload = { event: 'charge.completed', data: { id: 555, tx_ref: reference, status: 'successful', amount: 3500 } };
    await api.post('/api/payments/flutterwave/webhook').set('verif-hash', 'wrong').send(payload).expect(401);
    await api.post('/api/payments/flutterwave/webhook').set('verif-hash', FLW_HASH).send(payload).expect(200);
    assert.equal(await stockOf(product.id), 3);

    providerState.set('flw:556', { status: 'success', providerStatus: 'successful', reference, amount: 3500, currency: 'NGN' });
    await api
      .post('/api/payments/flutterwave/webhook')
      .set('verif-hash', FLW_HASH)
      .send({ event: 'charge.completed', data: { id: 556, tx_ref: reference } })
      .expect(200);
    assert.equal(await stockOf(product.id), 2);
  });
});

describe('Flutterwave redirect verification', () => {
  test('verifies by transaction id and rejects a transaction for a different reference', async () => {
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 1000, stock: 4 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 2 }], 'flutterwave');
    const { reference } = await startPayment(user, order.id, 'flutterwave');

    providerState.set('flw:777', { status: 'success', providerStatus: 'successful', reference: 'SOMEONE-ELSES-REF', amount: 3500, currency: 'NGN' });
    await api.get('/api/payments/flutterwave/verify/777').query({ tx_ref: reference }).set(user.auth).expect(400);
    assert.equal(await stockOf(product.id), 4);

    providerState.set('flw:778', { status: 'success', providerStatus: 'successful', reference, amount: 3500, currency: 'NGN' });
    const res = await api.get('/api/payments/flutterwave/verify/778').query({ tx_ref: reference }).set(user.auth).expect(200);
    assert.equal(res.body.state, 'paid');
    assert.equal(await stockOf(product.id), 2);
  });

  test('a cancelled checkout (no transaction id) stays unpaid', async () => {
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ stock: 4 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 1 }], 'flutterwave');
    const { reference } = await startPayment(user, order.id, 'flutterwave');
    const res = await api.get(`/api/payments/flutterwave/verify-reference/${reference}`).set(user.auth).expect(200);
    assert.equal(res.body.state, 'pending');
    assert.equal(res.body.order.paymentStatus, 'pending');
  });
});

describe('admin fulfilment after payment', () => {
  test('moves a paid order through the workflow; customer sees each status', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 1000, stock: 5 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 1 }]);
    const { reference } = await startPayment(user, order.id);
    providerState.set(reference, paystackSuccess(2500));
    await api.get(`/api/payments/paystack/verify/${reference}`).set(user.auth).expect(200);

    await api.put(`/api/admin/orders/${order.id}/status`).set(admin.auth).send({ status: 'shipped' }).expect(400);
    for (const status of ['processing', 'shipped', 'delivered']) {
      await api.put(`/api/admin/orders/${order.id}/status`).set(admin.auth).send({ status }).expect(200);
      const seen = await api.get(`/api/orders/${order.id}`).set(user.auth).expect(200);
      assert.equal(seen.body.order.orderStatus, status);
    }
    await api.put(`/api/admin/orders/${order.id}/status`).set(admin.auth).send({ status: 'cancelled' }).expect(400);

    const detail = await api.get(`/api/admin/orders/${order.id}`).set(admin.auth).expect(200);
    assert.deepEqual(
      detail.body.order.statusHistory.map((h) => h.status),
      ['pending', 'paid', 'processing', 'shipped', 'delivered'],
    );
    assert.equal(detail.body.order.payments[0].status, 'success');

    const stats = await api.get('/api/admin/stats').set(admin.auth).expect(200);
    assert.ok(stats.body.stats.completedOrders >= 1);
    assert.ok(stats.body.stats.totalRevenue >= 2500);
  });

  test('cancelling a paid order restores stock and can refund', async () => {
    const admin = await ctx.createUser({ role: 'admin' });
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 1000, stock: 5 });
    const order = await placeOrder(user, [{ productId: product.id, quantity: 2 }]);
    const { reference } = await startPayment(user, order.id);
    providerState.set(reference, paystackSuccess(3500));
    await api.get(`/api/payments/paystack/verify/${reference}`).set(user.auth).expect(200);
    assert.equal(await stockOf(product.id), 3);

    const res = await api
      .put(`/api/admin/orders/${order.id}/status`)
      .set(admin.auth)
      .send({ status: 'cancelled', note: 'Customer request', refund: true })
      .expect(200);
    assert.equal(res.body.order.orderStatus, 'cancelled');
    assert.equal(res.body.order.paymentStatus, 'refunded');
    assert.equal(await stockOf(product.id), 5);
    assert.deepEqual(refunds.map((r) => r.reference), [reference]);
  });
});

describe('abandoned orders', () => {
  test('stale unpaid orders expire, but paid-at-provider ones are settled instead', async () => {
    const user = await ctx.createUser();
    const product = await ctx.createProduct({ price: 1000, stock: 5 });

    const abandoned = await placeOrder(user, [{ productId: product.id, quantity: 1 }]);
    await startPayment(user, abandoned.id);
    const paidLate = await placeOrder(user, [{ productId: product.id, quantity: 1 }]);
    const { reference } = await startPayment(user, paidLate.id);
    providerState.set(reference, paystackSuccess(2500));

    await ctx.db.query(`update public.orders set created_at = now() - interval '3 days' where id = any($1::uuid[])`, [
      [abandoned.id, paidLate.id],
    ]);
    const expired = await ctx.paymentService.expireStalePendingOrders({ log: () => {} });
    assert.equal(expired, 1);

    const a = await api.get(`/api/orders/${abandoned.id}`).set(user.auth).expect(200);
    assert.equal(a.body.order.orderStatus, 'cancelled');
    const b = await api.get(`/api/orders/${paidLate.id}`).set(user.auth).expect(200);
    assert.equal(b.body.order.paymentStatus, 'paid');
    assert.equal(await stockOf(product.id), 4);
  });
});
