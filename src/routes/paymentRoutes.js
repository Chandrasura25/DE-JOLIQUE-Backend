import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { paymentLimiter, webhookLimiter } from '../middleware/rateLimiters.js';
import {
  flutterwaveWebhook,
  initialize,
  paystackWebhook,
  verifyFlutterwave,
  verifyFlutterwaveByReference,
  verifyPaystack,
} from '../controllers/paymentController.js';
import {
  flutterwaveVerifyQuery,
  initializePaymentBody,
  referenceParam,
  transactionIdParam,
} from '../validators/schemas.js';

const router = Router();

// Provider -> server. Authenticated by signature, not by user session.
router.post('/paystack/webhook', webhookLimiter, paystackWebhook);
router.post('/flutterwave/webhook', webhookLimiter, flutterwaveWebhook);

router.use(paymentLimiter, protect);

router.post('/paystack/initialize', validate({ body: initializePaymentBody }), initialize('paystack'));
router.get('/paystack/verify/:reference', validate({ params: referenceParam }), verifyPaystack);

router.post('/flutterwave/initialize', validate({ body: initializePaymentBody }), initialize('flutterwave'));
router.get(
  '/flutterwave/verify/:transactionId',
  validate({ params: transactionIdParam, query: flutterwaveVerifyQuery }),
  verifyFlutterwave,
);
router.get('/flutterwave/verify-reference/:reference', validate({ params: referenceParam }), verifyFlutterwaveByReference);

export default router;
