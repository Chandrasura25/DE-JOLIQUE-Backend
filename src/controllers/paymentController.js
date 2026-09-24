import asyncHandler from '../utils/asyncHandler.js';
import AppError from '../utils/AppError.js';
import { initializePayment, processPayment, gateways } from '../services/paymentService.js';
import { isTest } from '../config/env.js';

const respond = (res, result) =>
  res.json({ success: result.state === 'paid', state: result.state, message: result.message, order: result.order });

/** POST /api/payments/paystack/initialize  and  POST /api/payments/flutterwave/initialize */
export const initialize = (provider) =>
  asyncHandler(async (req, res) => {
    const result = await initializePayment(provider, req.user, req.body.orderId);
    res.json({ success: true, ...result });
  });

/** GET /api/payments/paystack/verify/:reference */
export const verifyPaystack = asyncHandler(async (req, res) => {
  const result = await processPayment({ provider: 'paystack', reference: req.params.reference, userId: req.user.id });
  respond(res, result);
});

/** GET /api/payments/flutterwave/verify/:transactionId?tx_ref=... */
export const verifyFlutterwave = asyncHandler(async (req, res) => {
  const result = await processPayment({
    provider: 'flutterwave',
    transactionId: req.params.transactionId,
    reference: req.query.tx_ref,
    userId: req.user.id,
  });
  respond(res, result);
});

/**
 * GET /api/payments/flutterwave/verify-reference/:reference
 * For redirects without a transaction id (e.g. the customer cancelled checkout).
 */
export const verifyFlutterwaveByReference = asyncHandler(async (req, res) => {
  const result = await processPayment({ provider: 'flutterwave', reference: req.params.reference, userId: req.user.id });
  respond(res, result);
});

async function handleWebhookEvent(provider, reference, transactionId) {
  try {
    await processPayment({ provider, reference, transactionId });
  } catch (err) {
    // Not one of our payments (e.g. another app on the same account): acknowledge it.
    if (err instanceof AppError && err.statusCode === 404) return;
    throw err; // a 5xx makes the provider retry later
  }
}

/** POST /api/payments/paystack/webhook — signature checked against the raw body. */
export const paystackWebhook = asyncHandler(async (req, res) => {
  if (!gateways.paystack.isValidWebhook(req.rawBody, req.headers['x-paystack-signature'])) {
    if (!isTest) console.warn('Rejected Paystack webhook with an invalid signature.');
    throw AppError.unauthorized('Invalid signature.');
  }
  const { event, data } = req.body || {};
  if (event === 'charge.success' && data?.reference) {
    await handleWebhookEvent('paystack', String(data.reference));
  }
  res.json({ received: true });
});

/** POST /api/payments/flutterwave/webhook — verif-hash must equal FLUTTERWAVE_WEBHOOK_HASH. */
export const flutterwaveWebhook = asyncHandler(async (req, res) => {
  if (!gateways.flutterwave.isValidWebhook(req.headers['verif-hash'])) {
    if (!isTest) console.warn('Rejected Flutterwave webhook with an invalid hash.');
    throw AppError.unauthorized('Invalid signature.');
  }
  const body = req.body || {};
  const data = body.data || body;
  const event = body.event || body['event.type'];
  if ((event === 'charge.completed' || event === 'CARD_TRANSACTION' || data?.tx_ref) && (data?.tx_ref || data?.id)) {
    await handleWebhookEvent('flutterwave', data.tx_ref ? String(data.tx_ref) : undefined, data.id ? String(data.id) : undefined);
  }
  res.json({ received: true });
});
