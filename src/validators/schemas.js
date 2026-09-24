import { z } from 'zod';

const trimmed = (min, max, label) =>
  z
    .string({ required_error: `${label} is required.`, invalid_type_error: `${label} must be text.` })
    .trim()
    .min(min, min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`)
    .max(max, `${label} must be at most ${max} characters.`);

const uuid = (label = 'id') => z.string().uuid(`Invalid ${label}.`);
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9\s()-]{7,20}$/, 'Enter a valid phone number.');

const boolFromQuery = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const page = z.coerce.number().int().min(1).max(10_000).default(1);
const limit = (max, fallback) => z.coerce.number().int().min(1).max(max).default(fallback);
const optionalMoney = z.coerce.number().min(0).max(1e10).optional();

export const idParam = z.object({ id: uuid() });
export const productIdOrSlugParam = z.object({ id: z.string().trim().min(1).max(120) });

// ----- Auth / profile -----
export const updateProfileBody = z
  .object({
    name: trimmed(2, 100, 'Name').optional(),
    phone: z.union([phone, z.literal('')]).optional(),
  })
  .refine((v) => v.name !== undefined || v.phone !== undefined, 'Nothing to update.');

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(72, 'Password must be at most 72 characters.')
  .regex(/[A-Za-z]/, 'Password must contain a letter.')
  .regex(/[0-9]/, 'Password must contain a number.');

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1, 'Current password is required.').max(200),
  newPassword: password,
});

const email = z.string({ required_error: 'Email is required.' }).trim().toLowerCase().email('Enter a valid email address.').max(254);
const nextPath = z.string().max(200).optional();

export const registerBody = z.object({
  name: trimmed(2, 100, 'Name'),
  email,
  phone: z.union([phone, z.literal('')]).optional(),
  password,
  next: nextPath,
});

export const loginBody = z.object({
  email,
  password: z.string({ required_error: 'Password is required.' }).min(1, 'Password is required.').max(200),
});

export const forgotPasswordBody = z.object({ email });

export const resetPasswordBody = z.object({ password });

export const oauthStartQuery = z.object({ next: nextPath });

export const oneTapBody = z.object({
  credential: z.string({ required_error: 'Missing Google credential.' }).min(20).max(8192),
});

// ----- Products -----
export const productListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  category: z.string().trim().max(120).optional(),
  minPrice: optionalMoney,
  maxPrice: optionalMoney,
  sort: z.enum(['newest', 'oldest', 'price_asc', 'price_desc', 'name', 'stock_asc']).default('newest'),
  featured: boolFromQuery,
  inStock: boolFromQuery,
  status: z.enum(['active', 'hidden']).optional(),
  stock: z.enum(['in', 'low', 'out']).optional(),
  page,
  limit: limit(60, 12),
});

const image = z.object({
  url: z.string().url('Invalid image URL.').max(1000),
  key: z.string().max(500).optional().nullable(),
  provider: z.enum(['local', 'supabase', 'cloudinary', 's3', 'external']).default('external'),
});

const productFields = {
  name: trimmed(2, 160, 'Name'),
  description: trimmed(10, 5000, 'Description'),
  price: z.coerce.number({ invalid_type_error: 'Price must be a number.' }).positive('Price must be greater than 0.').max(1e10),
  categoryId: z.union([uuid('category'), z.literal(''), z.null()]).optional(),
  stock: z.coerce.number().int('Stock must be a whole number.').min(0, 'Stock cannot be negative.').max(1_000_000),
  images: z.array(image).max(10, 'A product can have at most 10 images.'),
  featured: z.boolean(),
  isActive: z.boolean(),
};

export const createProductBody = z.object({
  ...productFields,
  images: productFields.images.default([]),
  featured: productFields.featured.default(false),
  isActive: productFields.isActive.default(true),
});

export const updateProductBody = z
  .object(productFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

// ----- Categories -----
export const categoryBody = z.object({
  name: trimmed(1, 80, 'Category name'),
  description: z.string().trim().max(500).optional(),
});
export const updateCategoryBody = categoryBody.partial();

// ----- Cart / orders -----
const cartItem = z.object({
  productId: uuid('product'),
  quantity: z.coerce.number().int().min(1, 'Quantity must be at least 1.').max(100, 'Maximum quantity is 100.'),
});

export const cartValidateBody = z.object({ items: z.array(cartItem).max(50) });

export const shippingAddress = z.object({
  fullName: trimmed(2, 100, 'Full name'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  phone,
  address: trimmed(5, 250, 'Delivery address'),
  city: trimmed(2, 100, 'City'),
  state: trimmed(2, 100, 'State'),
  country: trimmed(2, 100, 'Country'),
});

export const createOrderBody = z.object({
  items: z.array(cartItem).min(1, 'Your cart is empty.').max(50, 'Too many items in one order.'),
  shippingAddress,
  paymentMethod: z.enum(['paystack', 'flutterwave'], { errorMap: () => ({ message: 'Choose Paystack or Flutterwave.' }) }),
});

export const pageQuery = z.object({ page, limit: limit(50, 10) });

export const adminOrderListQuery = z.object({
  status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'paid', 'failed', 'refunded', 'attention']).optional(),
  search: z.string().trim().max(100).optional(),
  page,
  limit: limit(100, 20),
});

export const adminUserListQuery = z.object({
  role: z.enum(['customer', 'admin']).optional(),
  search: z.string().trim().max(100).optional(),
  page,
  limit: limit(100, 20),
});

export const updateOrderStatusBody = z.object({
  status: z.enum(['processing', 'shipped', 'delivered', 'cancelled']),
  note: z.string().trim().max(500).optional(),
  refund: z.boolean().default(false),
});

// ----- Payments -----
export const initializePaymentBody = z.object({ orderId: uuid('order') });
export const referenceParam = z.object({ reference: z.string().trim().min(6).max(100).regex(/^[A-Za-z0-9_-]+$/, 'Invalid reference.') });
export const transactionIdParam = z.object({ transactionId: z.string().trim().regex(/^\d{1,20}$/, 'Invalid transaction id.') });
export const flutterwaveVerifyQuery = z.object({
  tx_ref: z.string().trim().max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
});
