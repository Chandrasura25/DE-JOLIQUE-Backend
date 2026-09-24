import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const bool = (fallback) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (Supabase Postgres connection string)'),
  DATABASE_SSL: bool(true),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  SUPABASE_URL: z.string().url('SUPABASE_URL is required (https://<project>.supabase.co)'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required (server only, never expose it)'),
  // Session cookies. Use "none" only when the storefront and API are on different sites
  // (it forces the Secure flag, so the API must be served over HTTPS).
  AUTH_COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  SERVER_URL: z.string().url().default('http://localhost:5000'),
  SERVE_CLIENT: bool(false),

  STORE_NAME: z.string().default('De-Jolique Enterprise'),
  CURRENCY: z.string().length(3).default('NGN'),
  SHIPPING_FEE: z.coerce.number().min(0).default(0),
  LOW_STOCK_THRESHOLD: z.coerce.number().int().min(0).default(5),
  PENDING_ORDER_TTL_HOURS: z.coerce.number().min(0).default(48),
  // Vercel Cron sends it as "Authorization: Bearer <CRON_SECRET>". Leave empty to disable the endpoint.
  CRON_SECRET: optionalString,

  PAYSTACK_SECRET_KEY: optionalString,
  PAYSTACK_PUBLIC_KEY: optionalString,
  FLUTTERWAVE_SECRET_KEY: optionalString,
  FLUTTERWAVE_PUBLIC_KEY: optionalString,
  FLUTTERWAVE_WEBHOOK_HASH: optionalString,

  STORAGE_PROVIDER: z.enum(['local', 'supabase', 'cloudinary', 's3']).default('supabase'),
  SUPABASE_STORAGE_BUCKET: z.string().default('product-images'),
  CLOUDINARY_CLOUD_NAME: optionalString,
  CLOUDINARY_API_KEY: optionalString,
  CLOUDINARY_API_SECRET: optionalString,
  CLOUDINARY_FOLDER: z.string().default('jolique/products'),
  S3_BUCKET: optionalString,
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_PUBLIC_URL: optionalString,

  ADMIN_NAME: z.string().default('Store Admin'),
  ADMIN_EMAIL: z.string().email().default('admin@jolique.com'),
  ADMIN_PASSWORD: z.string().min(8).default('ChangeMe123!'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${problems}\n\nCopy server/.env.example to server/.env and fill it in.`);
  process.exit(1);
}

const env = parsed.data;

const missingForStorage = {
  supabase: [],
  cloudinary: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
  s3: ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PUBLIC_URL'],
  local: [],
}[env.STORAGE_PROVIDER].filter((key) => !env[key]);

if (missingForStorage.length) {
  console.error(`STORAGE_PROVIDER=${env.STORAGE_PROVIDER} requires: ${missingForStorage.join(', ')}`);
  process.exit(1);
}

export const isProduction = env.NODE_ENV === 'production';

/** Storefront origins allowed to call the API with credentials (CLIENT_URL, comma-separated). */
export const clientOrigins = env.CLIENT_URL.split(',').map((o) => o.trim().replace(/\/+$/, ''));
export const isTest = env.NODE_ENV === 'test';

export const paymentProviders = {
  paystack: Boolean(env.PAYSTACK_SECRET_KEY),
  flutterwave: Boolean(env.FLUTTERWAVE_SECRET_KEY),
};

export default env;
