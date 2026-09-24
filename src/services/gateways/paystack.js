import crypto from 'node:crypto';
import env from '../../config/env.js';
import AppError from '../../utils/AppError.js';
import { toMinorUnits } from '../../utils/helpers.js';
import { GatewayError, gatewayRequest, safeEqual } from './http.js';

const BASE_URL = 'https://api.paystack.co';
const NAME = 'Paystack';

function secretKey() {
  if (!env.PAYSTACK_SECRET_KEY) throw AppError.unavailable('Paystack payments are not available right now.');
  return env.PAYSTACK_SECRET_KEY;
}

async function call(path, options = {}) {
  const { ok, httpStatus, json } = await gatewayRequest(NAME, `${BASE_URL}${path}`, { ...options, secretKey: secretKey() });
  if (!ok || !json?.status) throw new GatewayError(NAME, json?.message || `HTTP ${httpStatus}`, httpStatus);
  return json.data;
}

// https://paystack.com/docs/api/transaction/#verify — anything not final is "pending".
const STATUS_MAP = { success: 'success', failed: 'failed', reversed: 'failed' };

/** Paystack integration. All calls use the secret key and run on the server only. */
export const paystack = {
  name: 'paystack',

  /** Returns { authorizationUrl, accessCode }. Amount is in major units (naira). */
  async initialize({ email, amount, currency, reference, callbackUrl, metadata }) {
    const data = await call('/transaction/initialize', {
      method: 'POST',
      body: {
        email,
        amount: toMinorUnits(amount),
        currency,
        reference,
        callback_url: callbackUrl,
        metadata,
      },
    });
    return { authorizationUrl: data.authorization_url, accessCode: data.access_code };
  },

  /** Asks Paystack for the authoritative state of a transaction. */
  async verify(reference) {
    const data = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
    return {
      status: STATUS_MAP[data.status] || 'pending',
      providerStatus: data.status,
      reference: data.reference,
      transactionId: data.id != null ? String(data.id) : null,
      // Paystack reports amounts in the minor unit (kobo).
      amount: Number(data.amount) / 100,
      currency: data.currency,
      channel: data.channel || null,
      gatewayResponse: data.gateway_response || null,
      paidAt: data.paid_at || data.paidAt || null,
      raw: {
        id: data.id,
        status: data.status,
        reference: data.reference,
        amount: data.amount,
        currency: data.currency,
        channel: data.channel,
        gateway_response: data.gateway_response,
        paid_at: data.paid_at,
        customer: data.customer ? { email: data.customer.email } : undefined,
      },
    };
  },

  async refund({ reference }) {
    await call('/refund', { method: 'POST', body: { transaction: reference } });
  },

  /** x-paystack-signature is an HMAC-SHA512 of the raw body, keyed with the secret key. */
  isValidWebhook(rawBody, signature) {
    if (!env.PAYSTACK_SECRET_KEY || !rawBody || !signature) return false;
    const expected = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  },
};
