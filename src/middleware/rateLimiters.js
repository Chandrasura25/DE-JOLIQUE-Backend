import rateLimit from 'express-rate-limit';
import { isTest } from '../config/env.js';

const make = (windowMinutes, limit, message) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: isTest ? 10_000 : limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message },
  });

export const apiLimiter = make(15, 600, 'Too many requests. Please slow down and try again shortly.');
export const authLimiter = make(15, 20, 'Too many attempts. Please wait a few minutes and try again.');
export const paymentLimiter = make(15, 60, 'Too many payment requests. Please wait a few minutes and try again.');
// Providers retry webhooks; keep this generous but bounded.
export const webhookLimiter = make(1, 300, 'Too many webhook calls.');
