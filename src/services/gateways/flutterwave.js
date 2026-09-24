import env from '../../config/env.js';
import AppError from '../../utils/AppError.js';
import { GatewayError, gatewayRequest, safeEqual } from './http.js';

const BASE_URL = 'https://api.flutterwave.com/v3';
const NAME = 'Flutterwave';

function secretKey() {
  if (!env.FLUTTERWAVE_SECRET_KEY) throw AppError.unavailable('Flutterwave payments are not available right now.');
  return env.FLUTTERWAVE_SECRET_KEY;
}

async function call(path, options = {}) {
  const { ok, httpStatus, json } = await gatewayRequest(NAME, `${BASE_URL}${path}`, { ...options, secretKey: secretKey() });
  if (!ok || json?.status !== 'success') throw new GatewayError(NAME, json?.message || `HTTP ${httpStatus}`, httpStatus);
  return json.data;
}

const STATUS_MAP = { successful: 'success', failed: 'failed', cancelled: 'failed' };

function normalize(data) {
  return {
    status: STATUS_MAP[String(data.status).toLowerCase()] || 'pending',
    providerStatus: data.status,
    reference: data.tx_ref,
    transactionId: data.id != null ? String(data.id) : null,
    // Flutterwave reports amounts in major units.
    amount: Number(data.amount),
    currency: data.currency,
    channel: data.payment_type || null,
    gatewayResponse: data.processor_response || null,
    paidAt: data.created_at || null,
    raw: {
      id: data.id,
      tx_ref: data.tx_ref,
      flw_ref: data.flw_ref,
      status: data.status,
      amount: data.amount,
      charged_amount: data.charged_amount,
      currency: data.currency,
      payment_type: data.payment_type,
      processor_response: data.processor_response,
      created_at: data.created_at,
    },
  };
}

/** Flutterwave Standard integration. All calls use the secret key and run on the server only. */
export const flutterwave = {
  name: 'flutterwave',

  /** Returns { authorizationUrl } — the hosted checkout link. */
  async initialize({ email, name, phone, amount, currency, reference, callbackUrl, metadata, title, logo }) {
    const data = await call('/payments', {
      method: 'POST',
      body: {
        tx_ref: reference,
        amount: String(amount),
        currency,
        redirect_url: callbackUrl,
        customer: { email, name, phonenumber: phone },
        customizations: { title, logo },
        meta: metadata,
      },
    });
    return { authorizationUrl: data.link };
  },

  /** Verifies by Flutterwave's transaction id (sent back on redirect and in webhooks). */
  async verify(transactionId) {
    return normalize(await call(`/transactions/${encodeURIComponent(transactionId)}/verify`));
  },

  /** Verifies by our tx_ref — used when we don't have Flutterwave's transaction id. */
  async verifyByReference(reference) {
    return normalize(await call(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`));
  },

  async refund({ transactionId }) {
    if (!transactionId) throw new Error('Flutterwave refunds need the transaction id.');
    await call(`/transactions/${encodeURIComponent(transactionId)}/refund`, { method: 'POST', body: {} });
  },

  /** Flutterwave sends the secret hash configured in the dashboard in the verif-hash header. */
  isValidWebhook(signature) {
    if (!env.FLUTTERWAVE_WEBHOOK_HASH || !signature) return false;
    return safeEqual(env.FLUTTERWAVE_WEBHOOK_HASH, signature);
  },
};
