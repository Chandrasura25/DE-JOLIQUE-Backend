import crypto from 'node:crypto';
import AppError from '../../utils/AppError.js';

export class GatewayError extends AppError {
  constructor(provider, message, httpStatus) {
    super(`We couldn't reach ${provider} right now. Please try again in a moment.`, 502);
    this.provider = provider;
    this.gatewayMessage = message;
    this.httpStatus = httpStatus;
  }
}

/** JSON request to a payment provider with a timeout. Returns the parsed body. */
export async function gatewayRequest(provider, url, { method = 'GET', secretKey, body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new GatewayError(provider, err.message, 0);
  }
  const json = await res.json().catch(() => null);
  return { ok: res.ok, httpStatus: res.status, json };
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}
