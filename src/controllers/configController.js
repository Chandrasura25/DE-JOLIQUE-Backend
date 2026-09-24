import env, { paymentProviders } from '../config/env.js';

/** GET /api/config — public, non-secret settings the storefront needs. */
export function getPublicConfig(req, res) {
  res.json({
    success: true,
    config: {
      storeName: env.STORE_NAME,
      currency: env.CURRENCY,
      shippingFee: env.SHIPPING_FEE,
      lowStockThreshold: env.LOW_STOCK_THRESHOLD,
      paymentProviders,
    },
  });
}
