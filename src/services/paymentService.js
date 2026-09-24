import env, { clientOrigins } from '../config/env.js';
import { query, withTransaction } from '../config/db.js';
import AppError from '../utils/AppError.js';
import { randomSuffix, toMinorUnits } from '../utils/helpers.js';
import { commitStock } from './inventoryService.js';
import { addHistory, getOrderById } from './orderService.js';
import { paystack } from './gateways/paystack.js';
import { flutterwave } from './gateways/flutterwave.js';
import { GatewayError } from './gateways/http.js';

export const gateways = { paystack, flutterwave };

const PROVIDER_LABEL = { paystack: 'Paystack', flutterwave: 'Flutterwave' };

function gatewayFor(provider) {
  const gateway = gateways[provider];
  if (!gateway) throw AppError.badRequest('Unsupported payment method.');
  return gateway;
}

async function getPaymentByReference(reference) {
  const { rows } = await query('select * from public.payments where reference = $1', [reference]);
  return rows[0] || null;
}

/**
 * Step 1 of checkout payment: re-checks the order, records a payment attempt with a
 * fresh reference and asks the provider for a hosted checkout URL.
 * The amount always comes from the stored order total, never from the client.
 */
export async function initializePayment(provider, user, orderId) {
  const gateway = gatewayFor(provider);

  const { order, reference } = await withTransaction(async (client) => {
    const { rows } = await client.query('select * from public.orders where id = $1 and user_id = $2 for update', [
      orderId,
      user.id,
    ]);
    const current = rows[0];
    if (!current) throw AppError.notFound('Order not found.');
    if (current.payment_status === 'paid') throw AppError.conflict('This order has already been paid.');
    if (current.order_status !== 'pending' || current.payment_status === 'refunded') {
      throw AppError.conflict('This order can no longer be paid. Please place a new order.');
    }

    // Stock is re-checked here so nobody pays for something that has since sold out.
    const { rows: shortages } = await client.query(
      `select oi.name, coalesce(p.stock, 0) as stock, oi.quantity
         from public.order_items oi
         left join public.products p on p.id = oi.product_id and p.is_active
        where oi.order_id = $1 and (p.id is null or p.stock < oi.quantity)`,
      [orderId],
    );
    if (shortages.length) {
      const s = shortages[0];
      throw AppError.conflict(s.stock > 0 ? `Only ${s.stock} of "${s.name}" left in stock.` : `"${s.name}" is out of stock.`);
    }

    const ref = `${current.order_number}-${provider === 'paystack' ? 'PS' : 'FW'}-${randomSuffix(5)}`.toUpperCase();
    await client.query(
      `insert into public.payments (order_id, user_id, provider, reference, amount, currency)
       values ($1, $2, $3, $4, $5, $6)`,
      [orderId, user.id, provider, ref, current.total_amount, current.currency.trim()],
    );
    await client.query(
      `update public.orders set payment_method = $2, payment_reference = $3, payment_status = 'pending' where id = $1`,
      [orderId, provider, ref],
    );
    return { order: current, reference: ref };
  });

  const callbackUrl = `${clientOrigins[0]}/payment/callback?provider=${provider}&order=${orderId}`;
  const address = order.shipping_address || {};

  try {
    const { authorizationUrl } = await gateway.initialize({
      email: address.email || user.email,
      name: address.fullName || user.name,
      phone: address.phone || user.phone || undefined,
      amount: order.total_amount,
      currency: order.currency.trim(),
      reference,
      callbackUrl,
      title: env.STORE_NAME,
      metadata: { orderId, orderNumber: order.order_number, userId: user.id },
    });
    return { authorizationUrl, reference, provider };
  } catch (err) {
    await query(`update public.payments set status = 'failed', note = $2 where reference = $1`, [
      reference,
      `Initialization failed: ${err.gatewayMessage || err.message}`.slice(0, 500),
    ]);
    throw err;
  }
}

function summarize(order, state, message) {
  return { state, message, order };
}

async function outcomeFor(payment) {
  const order = await getOrderById(payment.order_id);
  if (payment.status === 'success' && order.paymentStatus === 'paid' && order.paymentReference === payment.reference) {
    return summarize(order, 'paid', 'Your order was successfully placed.');
  }
  if (payment.status === 'refunded' || order.paymentStatus === 'refunded') {
    return summarize(
      order,
      'refunded',
      'Sorry, an item in your order sold out before your payment completed. Your payment has been refunded.',
    );
  }
  if (payment.status === 'success') {
    return summarize(order, 'attention', 'We received your payment and our team is reviewing your order. We will contact you shortly.');
  }
  if (payment.status === 'failed') return summarize(order, 'failed', 'Payment failed. Please try again.');
  return summarize(order, 'pending', 'We have not received confirmation of your payment yet.');
}

/**
 * Verifies a payment with the provider and, if it succeeded, marks the order paid and
 * deducts stock exactly once. Safe to call any number of times, concurrently, from the
 * redirect callback and from webhooks — the payment row lock and status checks make
 * repeat calls no-ops.
 *
 * Returns { state: 'paid'|'failed'|'pending'|'refunded'|'attention', message, order }.
 */
export async function processPayment({ provider, reference, transactionId, userId }) {
  const gateway = gatewayFor(provider);
  let verification = null;
  let payment = reference ? await getPaymentByReference(reference) : null;

  // Flutterwave redirects/webhooks may only give us their transaction id.
  if (!payment && provider === 'flutterwave' && transactionId) {
    verification = await gateway.verify(transactionId);
    payment = verification.reference ? await getPaymentByReference(verification.reference) : null;
  }
  if (!payment || payment.provider !== provider) throw AppError.notFound('Payment not found.');
  if (userId && payment.user_id !== userId) throw AppError.notFound('Payment not found.');

  // Already settled: nothing to do.
  if (payment.status === 'success' || payment.status === 'refunded') return outcomeFor(payment);

  if (!verification) {
    try {
      if (provider === 'paystack') verification = await gateway.verify(payment.reference);
      else if (transactionId) verification = await gateway.verify(transactionId);
      else verification = await gateway.verifyByReference(payment.reference);
    } catch (err) {
      // The provider has no record of a completed transaction (e.g. checkout closed).
      if (err instanceof GatewayError && [400, 404].includes(err.httpStatus)) {
        verification = { status: 'pending', reference: payment.reference };
      } else {
        throw err;
      }
    }
  }

  // The transaction the provider describes must be the one we are settling.
  if (verification.reference && verification.reference !== payment.reference) {
    throw AppError.badRequest('Payment reference mismatch.');
  }

  if (verification.status === 'pending') {
    if (payment.status === 'initialized') {
      await query(`update public.payments set status = 'pending' where id = $1 and status = 'initialized'`, [payment.id]);
    }
    return outcomeFor({ ...payment, status: 'pending' });
  }

  if (verification.status === 'failed') {
    await markFailed(payment, verification, verification.gatewayResponse || `Payment ${verification.providerStatus || 'failed'}`);
    return outcomeFor({ ...payment, status: 'failed' });
  }

  // Successful at the provider: the amount and currency must match what we charged.
  const currencyOk = String(verification.currency).toUpperCase() === payment.currency.trim().toUpperCase();
  const amountOk = toMinorUnits(verification.amount) >= toMinorUnits(payment.amount);
  if (!currencyOk || !amountOk) {
    await markFailed(
      payment,
      verification,
      `Amount/currency mismatch: expected ${payment.amount} ${payment.currency.trim()}, got ${verification.amount} ${verification.currency}`,
      { flagOrder: true },
    );
    return outcomeFor({ ...payment, status: 'failed' });
  }

  const settled = await settleSuccessfulPayment(payment.id, verification);
  if (settled.refundReason) await refundPayment(settled.payment, settled.refundReason);

  return outcomeFor(await getPaymentByReference(payment.reference));
}

async function markFailed(payment, verification, note, { flagOrder = false } = {}) {
  await withTransaction(async (client) => {
    const { rows } = await client.query('select * from public.payments where id = $1 for update', [payment.id]);
    if (['success', 'refunded'].includes(rows[0].status)) return;

    await client.query(
      `update public.payments
          set status = 'failed', note = $2, provider_transaction_id = coalesce($3, provider_transaction_id),
              gateway_response = coalesce($4, gateway_response), raw = coalesce($5::jsonb, raw), verified_at = now()
        where id = $1`,
      [payment.id, note.slice(0, 500), verification.transactionId ?? null, verification.gatewayResponse ?? null,
        verification.raw ? JSON.stringify(verification.raw) : null],
    );
    const { rowCount } = await client.query(
      `update public.orders
          set payment_status = 'failed',
              requires_attention = requires_attention or $3,
              admin_note = case when $3 then $4 else admin_note end
        where id = $1 and payment_reference = $2 and payment_status = 'pending'`,
      [payment.order_id, payment.reference, flagOrder, note.slice(0, 500)],
    );
    if (rowCount) await addHistory(client, payment.order_id, 'payment_failed', note.slice(0, 200));
  });
}

/**
 * The single place an order becomes paid. Runs in one transaction holding row locks on
 * the payment and the order, so it applies at most once per payment and per order.
 */
async function settleSuccessfulPayment(paymentId, verification) {
  return withTransaction(async (client) => {
    const { rows: paymentRows } = await client.query('select * from public.payments where id = $1 for update', [paymentId]);
    const payment = paymentRows[0];
    if (payment.status === 'success' || payment.status === 'refunded') return { payment };

    const { rows: orderRows } = await client.query('select * from public.orders where id = $1 for update', [
      payment.order_id,
    ]);
    const order = orderRows[0];
    let refundReason = null;
    let note = null;

    if (order.payment_status === 'paid' || order.payment_status === 'refunded' || order.order_status !== 'pending') {
      // Money arrived for an order that is already paid (another attempt succeeded)
      // or no longer payable (cancelled/expired). Record it and give it back.
      refundReason = order.payment_status === 'paid' ? 'Duplicate payment for an already paid order' : `Payment received for a ${order.order_status} order`;
      note = refundReason;
      await client.query(
        `update public.orders set requires_attention = true, admin_note = $2 where id = $1`,
        [order.id, `${refundReason} (reference ${payment.reference}). Refund initiated.`],
      );
    } else {
      const { rows: items } = await client.query(
        'select product_id, name, quantity from public.order_items where order_id = $1',
        [order.id],
      );
      const stock = await commitStock(client, items);

      if (stock.ok) {
        await client.query(
          `update public.orders
              set payment_status = 'paid', paid_at = now(), inventory_committed = true,
                  payment_method = $2, payment_reference = $3
            where id = $1`,
          [order.id, payment.provider, payment.reference],
        );
        await addHistory(client, order.id, 'paid', `Payment confirmed by ${PROVIDER_LABEL[payment.provider]}`);
      } else {
        // Another customer bought the last unit(s) first. Never oversell: cancel and refund.
        const names = stock.unavailable.map((u) => u.name).join(', ');
        refundReason = `Out of stock at payment confirmation: ${names}`;
        note = refundReason;
        await client.query(
          `update public.orders
              set payment_status = 'paid', paid_at = now(), order_status = 'cancelled', cancelled_at = now(),
                  payment_method = $2, payment_reference = $3, requires_attention = true, admin_note = $4
            where id = $1`,
          [order.id, payment.provider, payment.reference, `${refundReason}. Refund initiated.`],
        );
        await addHistory(client, order.id, 'cancelled', 'Item sold out before payment completed');
      }
    }

    const { rows: updated } = await client.query(
      `update public.payments
          set status = 'success', amount_paid = $2, provider_transaction_id = coalesce($3, provider_transaction_id),
              channel = $4, gateway_response = $5, raw = $6::jsonb, note = $7,
              paid_at = coalesce($8::timestamptz, now()), verified_at = now()
        where id = $1
        returning *`,
      [payment.id, verification.amount, verification.transactionId, verification.channel, verification.gatewayResponse,
        JSON.stringify(verification.raw ?? null), note, verification.paidAt],
    );

    return { payment: updated[0], refundReason };
  });
}

/**
 * Asks the provider to refund a successful payment. On success the payment (and the
 * order, if this payment is the order's payment) are marked refunded; on failure the
 * order stays flagged for a manual refund.
 */
export async function refundPayment(payment, reason) {
  const gateway = gatewayFor(payment.provider);
  try {
    await gateway.refund({ reference: payment.reference, transactionId: payment.provider_transaction_id });
  } catch (err) {
    const message = `Automatic refund failed (${err.gatewayMessage || err.message}). Refund reference ${payment.reference} manually.`;
    await query('update public.orders set requires_attention = true, admin_note = $2 where id = $1', [
      payment.order_id,
      `${reason}. ${message}`.slice(0, 1000),
    ]);
    await query('update public.payments set note = $2 where id = $1', [payment.id, message.slice(0, 500)]);
    return { refunded: false, message };
  }

  await withTransaction(async (client) => {
    await client.query(`update public.payments set status = 'refunded', note = $2 where id = $1`, [
      payment.id,
      `Refunded: ${reason}`.slice(0, 500),
    ]);
    const { rowCount } = await client.query(
      `update public.orders
          set payment_status = 'refunded', requires_attention = false,
              admin_note = $3
        where id = $1 and payment_reference = $2 and payment_status = 'paid'`,
      [payment.order_id, payment.reference, `${reason}. Refund initiated with ${PROVIDER_LABEL[payment.provider]}.`],
    );
    if (rowCount) await addHistory(client, payment.order_id, 'refunded', reason.slice(0, 200));
    else {
      await client.query('update public.orders set requires_attention = false, admin_note = $2 where id = $1', [
        payment.order_id,
        `${reason} (reference ${payment.reference}): refund initiated.`,
      ]);
    }
  });
  return { refunded: true };
}

/** Refund for an admin-cancelled paid order. */
export async function refundOrder(orderId, reason) {
  const { rows } = await query(
    `select p.* from public.payments p join public.orders o on o.id = p.order_id
      where o.id = $1 and p.reference = o.payment_reference and p.status = 'success'`,
    [orderId],
  );
  if (!rows[0]) return { refunded: false, message: 'No successful payment found to refund.' };
  return refundPayment(rows[0], reason);
}

/**
 * Cancels abandoned unpaid orders after PENDING_ORDER_TTL_HOURS. Each one is checked
 * with its provider first, so an order whose payment actually succeeded is settled
 * instead of cancelled.
 */
export async function expireStalePendingOrders({ log = console.log } = {}) {
  if (!env.PENDING_ORDER_TTL_HOURS) return 0;
  const { rows } = await query(
    `select id, payment_method, payment_reference from public.orders
      where order_status = 'pending' and payment_status in ('pending', 'failed')
        and created_at < now() - make_interval(hours => $1)
      order by created_at limit 50`,
    [env.PENDING_ORDER_TTL_HOURS],
  );

  let expired = 0;
  for (const order of rows) {
    try {
      if (order.payment_reference && gateways[order.payment_method] && (await isProviderConfigured(order.payment_method))) {
        const result = await processPayment({ provider: order.payment_method, reference: order.payment_reference });
        if (result.state !== 'pending' && result.state !== 'failed') continue;
      }
      await withTransaction(async (client) => {
        const { rowCount } = await client.query(
          `update public.orders set order_status = 'cancelled', cancelled_at = now()
            where id = $1 and order_status = 'pending' and payment_status in ('pending', 'failed')`,
          [order.id],
        );
        if (rowCount) {
          await addHistory(client, order.id, 'cancelled', 'Cancelled automatically: payment not completed in time');
          expired += 1;
        }
      });
    } catch (err) {
      log(`Could not expire order ${order.id}: ${err.message}`);
    }
  }
  return expired;
}

async function isProviderConfigured(provider) {
  return provider === 'paystack' ? Boolean(env.PAYSTACK_SECRET_KEY) : Boolean(env.FLUTTERWAVE_SECRET_KEY);
}
