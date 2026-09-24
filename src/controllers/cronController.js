import crypto from 'node:crypto';
import env from '../config/env.js';
import asyncHandler from '../utils/asyncHandler.js';
import AppError from '../utils/AppError.js';
import { expireStalePendingOrders } from '../services/paymentService.js';

function isCronRequest(req) {
  if (!env.CRON_SECRET) return false;
  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  const given = Buffer.from(req.headers.authorization || '');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * GET /api/cron/expire-orders — called by Vercel Cron (see vercel.json). On a
 * long-running server src/index.js does the same sweep on a timer instead.
 */
export const expireOrdersCron = asyncHandler(async (req, res) => {
  if (!isCronRequest(req)) throw AppError.notFound();
  const expired = await expireStalePendingOrders();
  res.json({ success: true, expired });
});
