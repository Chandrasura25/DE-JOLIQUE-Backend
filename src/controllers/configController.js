import env, { paymentProviders } from '../config/env.js';
import asyncHandler from '../utils/asyncHandler.js';
import { getStoreSettings, updateStoreSettings } from '../services/settingsService.js';

/** GET /api/config — public, non-secret settings the storefront needs. */
export const getPublicConfig = asyncHandler(async (req, res) => {
  const { supportEmail, supportPhone, postalAddress } = await getStoreSettings();
  res.json({
    success: true,
    config: {
      storeName: env.STORE_NAME,
      currency: env.CURRENCY,
      shippingFee: env.SHIPPING_FEE,
      lowStockThreshold: env.LOW_STOCK_THRESHOLD,
      paymentProviders,
      contact: { email: supportEmail, phone: supportPhone, address: postalAddress },
    },
  });
});

/** GET /api/admin/settings */
export const getAdminSettings = asyncHandler(async (req, res) => {
  res.json({ success: true, settings: await getStoreSettings() });
});

/** PUT /api/admin/settings */
export const updateAdminSettings = asyncHandler(async (req, res) => {
  const settings = await updateStoreSettings(req.user.id, req.body);
  res.json({ success: true, message: 'Store settings saved.', settings });
});
