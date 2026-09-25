import env from '../config/env.js';

/**
 * OpenAPI 3.0 description of the API, served by Swagger UI at /api/docs.
 * tests/docs.test.js fails if a route exists in Express but not here.
 */

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ content: { 'application/json': { schema } } });
const ok = (schema, description = 'OK') => ({ description, ...json(schema) });
const envelope = (props) => ({
  type: 'object',
  properties: { success: { type: 'boolean', example: true }, message: { type: 'string' }, ...props },
});
const err = (description) => ({ description, ...json(ref('Error')) });

const E = {
  400: err('Validation error'),
  401: err('Missing, invalid or expired Supabase access token'),
  403: err('Not an admin (or admin must change password first: code PASSWORD_CHANGE_REQUIRED)'),
  404: err('Not found'),
  409: err('Conflict (e.g. out of stock, already paid)'),
  429: err('Rate limited'),
  502: err('Payment provider unreachable'),
  503: err('Payment provider not configured'),
};

const pick = (...codes) => Object.fromEntries(codes.map((c) => [c, E[c]]));
const bearer = [{ sessionCookie: [] }, { supabaseAuth: [] }];
const redirect = (description) => ({ description, headers: { Location: { schema: { type: 'string', format: 'uri' } } } });
const idParam = (name = 'id', description = 'UUID') => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string', format: 'uuid' },
});
const q = (name, schema, description) => ({ name, in: 'query', required: false, schema, description });
const pageParams = [q('page', { type: 'integer', minimum: 1, default: 1 }), q('limit', { type: 'integer', minimum: 1 })];

const productQuery = [
  q('search', { type: 'string', maxLength: 100 }, 'Matches name or description'),
  q('category', { type: 'string' }, 'Category slug or id'),
  q('minPrice', { type: 'number', minimum: 0 }),
  q('maxPrice', { type: 'number', minimum: 0 }),
  q('sort', { type: 'string', enum: ['newest', 'oldest', 'price_asc', 'price_desc', 'name', 'stock_asc'], default: 'newest' }),
  q('featured', { type: 'boolean' }),
  q('inStock', { type: 'boolean' }),
  ...pageParams,
];

export function buildOpenApiSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: `${env.STORE_NAME} API`,
      version: '1.0.0',
      description: [
        'REST API for the De-Jolique Enterprise store (Express + Supabase Postgres).',
        '',
        '**Authentication** — Supabase Auth issues the tokens, but only this API handles them. `POST /auth/login`,',
        '`POST /auth/register` and the Google flow (`GET /auth/google`) put the access and refresh tokens in httpOnly',
        'cookies scoped to `/api`, and expired access tokens are refreshed automatically. Non-browser clients can send',
        '`Authorization: Bearer <access_token>` instead. Roles (`customer` / `admin`) are read from `public.profiles`',
        'on every request.',
        '',
        '**Payments** — orders are priced on the server. Payment state only changes after the server verifies the',
        'transaction with Paystack/Flutterwave; verification is idempotent.',
      ].join('\n'),
    },
    servers: [{ url: '/api', description: 'This server' }],
    tags: [
      { name: 'System' },
      { name: 'Auth', description: 'Sessions (Supabase Auth tokens in httpOnly cookies) and the signed-in user profile' },
      { name: 'Products' },
      { name: 'Categories' },
      { name: 'Cart' },
      { name: 'Orders' },
      { name: 'Payments' },
      { name: 'Webhooks', description: 'Called by payment providers, authenticated by signature' },
      { name: 'Admin' },
    ],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'jq_access',
          description: 'Set by /auth/login, /auth/register or /auth/callback (with jq_refresh for automatic refresh)',
        },
        supabaseAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Supabase Auth access token (session.access_token)',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string', example: 'This product is out of stock.' },
            code: { type: 'string', example: 'PASSWORD_CHANGE_REQUIRED' },
            details: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
          },
        },
        Pagination: {
          type: 'object',
          properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, pages: { type: 'integer' } },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string', nullable: true },
            role: { type: 'string', enum: ['customer', 'admin'] },
            mustChangePassword: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        AdminUser: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string', nullable: true },
            role: { type: 'string', enum: ['customer', 'admin'] },
            mustChangePassword: { type: 'boolean' },
            providers: { type: 'array', items: { type: 'string' }, example: ['email', 'google'] },
            emailConfirmed: { type: 'boolean' },
            lastSignInAt: { type: 'string', format: 'date-time', nullable: true },
            orderCount: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        StoreSettings: {
          type: 'object',
          properties: {
            supportEmail: { type: 'string', format: 'email' },
            supportPhone: { type: 'string', example: '+2348012345678' },
            postalAddress: { type: 'string', maxLength: 300 },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        Image: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', format: 'uri' },
            key: { type: 'string', nullable: true },
            provider: { type: 'string', enum: ['local', 'supabase', 'cloudinary', 's3', 'external'] },
          },
        },
        Category: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            slug: { type: 'string' },
            description: { type: 'string' },
            productCount: { type: 'integer' },
          },
        },
        Product: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            slug: { type: 'string' },
            description: { type: 'string' },
            price: { type: 'number', example: 54000 },
            stock: { type: 'integer' },
            inStock: { type: 'boolean' },
            lowStock: { type: 'boolean' },
            images: { type: 'array', items: ref('Image') },
            featured: { type: 'boolean' },
            isActive: { type: 'boolean' },
            category: { allOf: [ref('Category')], nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ProductInput: {
          type: 'object',
          required: ['name', 'description', 'price', 'stock'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 160 },
            description: { type: 'string', minLength: 10, maxLength: 5000 },
            price: { type: 'number', exclusiveMinimum: true, minimum: 0 },
            categoryId: { type: 'string', format: 'uuid', nullable: true },
            stock: { type: 'integer', minimum: 0 },
            images: { type: 'array', maxItems: 10, items: ref('Image') },
            featured: { type: 'boolean', default: false },
            isActive: { type: 'boolean', default: true },
          },
        },
        CartItem: {
          type: 'object',
          required: ['productId', 'quantity'],
          properties: { productId: { type: 'string', format: 'uuid' }, quantity: { type: 'integer', minimum: 1, maximum: 100 } },
        },
        ShippingAddress: {
          type: 'object',
          required: ['fullName', 'email', 'phone', 'address', 'city', 'state', 'country'],
          properties: {
            fullName: { type: 'string', example: 'Ada Lovelace' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string', example: '+2348012345678' },
            address: { type: 'string', example: '12 Marina Road' },
            city: { type: 'string', example: 'Lagos' },
            state: { type: 'string', example: 'Lagos' },
            country: { type: 'string', example: 'Nigeria' },
          },
        },
        OrderItem: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            productId: { type: 'string', format: 'uuid', nullable: true },
            name: { type: 'string' },
            image: { type: 'string', nullable: true },
            price: { type: 'number' },
            quantity: { type: 'integer' },
            subtotal: { type: 'number' },
          },
        },
        Order: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            orderNumber: { type: 'string', example: 'JQ-001042' },
            customer: { type: 'object', nullable: true, properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } } },
            items: { type: 'array', items: ref('OrderItem') },
            itemCount: { type: 'integer' },
            shippingAddress: ref('ShippingAddress'),
            paymentMethod: { type: 'string', enum: ['paystack', 'flutterwave'] },
            paymentReference: { type: 'string', nullable: true },
            paymentStatus: { type: 'string', enum: ['pending', 'paid', 'failed', 'refunded'] },
            orderStatus: { type: 'string', enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'] },
            subtotal: { type: 'number' },
            shippingFee: { type: 'number' },
            totalAmount: { type: 'number' },
            currency: { type: 'string', example: 'NGN' },
            paidAt: { type: 'string', format: 'date-time', nullable: true },
            deliveredAt: { type: 'string', format: 'date-time', nullable: true },
            cancelledAt: { type: 'string', format: 'date-time', nullable: true },
            statusHistory: {
              type: 'array',
              items: { type: 'object', properties: { status: { type: 'string' }, note: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' } } },
            },
            requiresAttention: { type: 'boolean', description: 'Admin only' },
            adminNote: { type: 'string', nullable: true, description: 'Admin only' },
            payments: { type: 'array', description: 'Admin detail only', items: { type: 'object' } },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        PaymentInit: envelope({
          authorizationUrl: { type: 'string', format: 'uri', description: 'Redirect the customer here' },
          reference: { type: 'string', example: 'JQ-001042-PS-3FA9C1B2E0' },
          provider: { type: 'string', enum: ['paystack', 'flutterwave'] },
        }),
        PaymentResult: {
          type: 'object',
          properties: {
            success: { type: 'boolean', description: 'true only when state is paid' },
            state: { type: 'string', enum: ['paid', 'pending', 'failed', 'refunded', 'attention'] },
            message: { type: 'string', example: 'Your order was successfully placed.' },
            order: ref('Order'),
          },
        },
        Stats: {
          type: 'object',
          properties: {
            totalProducts: { type: 'integer' },
            outOfStockProducts: { type: 'integer' },
            lowStockProducts: { type: 'integer' },
            totalOrders: { type: 'integer' },
            pendingOrders: { type: 'integer' },
            paidOrders: { type: 'integer' },
            completedOrders: { type: 'integer' },
            ordersNeedingAttention: { type: 'integer' },
            totalRevenue: { type: 'number' },
            currency: { type: 'string' },
            lowStockThreshold: { type: 'integer' },
            recentOrders: { type: 'array', items: ref('Order') },
            lowStock: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
    paths: {
      '/health': { get: { tags: ['System'], summary: 'Health check', responses: { 200: ok(envelope({ status: { type: 'string' } })) } } },
      '/config': {
        get: {
          tags: ['System'],
          summary: 'Public store settings (currency, delivery fee, enabled payment providers, contact email/phone/address)',
          responses: { 200: ok(envelope({ config: { type: 'object' } })) },
        },
      },

      '/cron/expire-orders': {
        get: {
          tags: ['System'],
          summary: 'Cancel abandoned unpaid orders (Vercel Cron only; needs Authorization: Bearer <CRON_SECRET>)',
          responses: { 200: ok(envelope({ expired: { type: 'integer' } })), ...pick(404) },
        },
      },
      '/auth/providers': {
        get: {
          tags: ['Auth'],
          summary: 'Sign-in methods enabled in Supabase Auth',
          responses: {
            200: ok(
              envelope({
                providers: {
                  type: 'object',
                  properties: {
                    email: { type: 'boolean' },
                    google: { type: 'boolean' },
                    googleOneTapClientId: { type: 'string', nullable: true, description: 'Set when Google One Tap is available' },
                  },
                },
              }),
            ),
          },
        },
      },
      '/auth/google/one-tap/nonce': {
        get: {
          tags: ['Auth'],
          summary: 'Nonce for the next Google One Tap prompt (SHA-256; the raw value is kept in an httpOnly cookie)',
          responses: { 200: ok(envelope({ nonce: { type: 'string' } })), ...pick(429) },
        },
      },
      '/auth/google/one-tap': {
        post: {
          tags: ['Auth'],
          summary: 'Sign in with a Google One Tap ID token (sets session cookies). Needs the nonce cookie from the nonce call.',
          requestBody: json({ type: 'object', required: ['credential'], properties: { credential: { type: 'string', description: 'Google ID token' } } }),
          responses: { 200: ok(envelope({ user: ref('User') })), ...pick(400, 429) },
        },
      },
      '/auth/register': {
        post: {
          tags: ['Auth'],
          summary: 'Create an account. Starts a session unless the project requires email confirmation.',
          requestBody: json({
            type: 'object',
            required: ['name', 'email', 'password', 'confirmPassword'],
            properties: {
              name: { type: 'string', minLength: 2, maxLength: 100 },
              email: { type: 'string', format: 'email' },
              phone: { type: 'string' },
              password: { type: 'string', minLength: 8, maxLength: 72, description: 'At least one uppercase letter, one lowercase letter, one number and one special character' },
              confirmPassword: { type: 'string', description: 'Must equal the new password' },
              next: { type: 'string', description: 'Storefront path to open after the confirmation link', example: '/account' },
            },
          }),
          responses: {
            201: ok(envelope({ needsConfirmation: { type: 'boolean' }, user: ref('User') }), 'Created (sets session cookies unless needsConfirmation)'),
            ...pick(400, 409, 429),
          },
        },
      },
      '/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Sign in with email and password (sets session cookies)',
          requestBody: json({
            type: 'object',
            required: ['email', 'password'],
            properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } },
          }),
          responses: { 200: ok(envelope({ user: ref('User') })), ...pick(400, 429) },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['Auth'],
          summary: 'Revoke this session in Supabase Auth and clear the cookies',
          responses: { 200: ok(envelope({})) },
        },
      },
      '/auth/google': {
        get: {
          tags: ['Auth'],
          summary: 'Start Google sign-in (open in the browser, not via XHR)',
          parameters: [q('next', { type: 'string', example: '/checkout' }, 'Storefront path to land on afterwards')],
          responses: { 302: redirect('To Google via Supabase Auth, or back to /login?auth=unavailable'), ...pick(429) },
        },
      },
      '/auth/callback': {
        get: {
          tags: ['Auth'],
          summary: 'Return URL for Google, email confirmation and password recovery (sets session cookies)',
          parameters: [q('code', { type: 'string' }, 'PKCE auth code from Supabase Auth'), q('error', { type: 'string' })],
          responses: { 302: redirect('To the storefront, or /login?auth=cancelled|failed|expired|verified') },
        },
      },
      '/auth/forgot-password': {
        post: {
          tags: ['Auth'],
          summary: 'Email a password-reset link (same response whether or not the account exists)',
          requestBody: json({ type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } }),
          responses: { 200: ok(envelope({})), ...pick(400, 429) },
        },
      },
      '/auth/reset-password': {
        post: {
          tags: ['Auth'],
          summary: 'Set a new password. Only works in a session opened from a recovery link within the last hour.',
          security: bearer,
          requestBody: json({ type: 'object', required: ['password', 'confirmPassword'], properties: { password: { type: 'string', minLength: 8, maxLength: 72, description: 'At least one uppercase letter, one lowercase letter, one number and one special character' }, confirmPassword: { type: 'string', description: 'Must equal the new password' } } }),
          responses: { 200: ok(envelope({ user: ref('User') })), ...pick(400, 401, 403, 429) },
        },
      },
      '/auth/me': {
        get: { tags: ['Auth'], summary: 'Current user profile', security: bearer, responses: { 200: ok(envelope({ user: ref('User') })), ...pick(401) } },
        put: {
          tags: ['Auth'],
          summary: 'Update name / phone',
          security: bearer,
          requestBody: json({ type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' } } }),
          responses: { 200: ok(envelope({ user: ref('User') })), ...pick(400, 401) },
        },
      },
      '/auth/change-password': {
        put: {
          tags: ['Auth'],
          summary: 'Change password (verifies the current one; clears the forced-change flag)',
          security: bearer,
          requestBody: json({
            type: 'object',
            required: ['currentPassword', 'newPassword', 'confirmPassword'],
            properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 8, maxLength: 72, description: 'At least one uppercase letter, one lowercase letter, one number and one special character' }, confirmPassword: { type: 'string', description: 'Must equal the new password' } },
          }),
          responses: { 200: ok(envelope({ user: ref('User') })), ...pick(400, 401, 429) },
        },
      },

      '/products': {
        get: {
          tags: ['Products'],
          summary: 'List active products (search, filter, sort, paginate)',
          parameters: productQuery,
          responses: { 200: ok(envelope({ products: { type: 'array', items: ref('Product') }, pagination: ref('Pagination') })), ...pick(400) },
        },
        post: {
          tags: ['Products', 'Admin'],
          summary: 'Create product (admin)',
          security: bearer,
          requestBody: json(ref('ProductInput')),
          responses: { 201: ok(envelope({ product: ref('Product') }), 'Created'), ...pick(400, 401, 403) },
        },
      },
      '/products/{id}': {
        get: {
          tags: ['Products'],
          summary: 'Get product by id or slug',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'UUID or slug' }],
          responses: { 200: ok(envelope({ product: ref('Product') })), ...pick(404) },
        },
        put: {
          tags: ['Products', 'Admin'],
          summary: 'Update product (admin; partial)',
          security: bearer,
          parameters: [idParam()],
          requestBody: json(ref('ProductInput')),
          responses: { 200: ok(envelope({ product: ref('Product') })), ...pick(400, 401, 403, 404) },
        },
        delete: {
          tags: ['Products', 'Admin'],
          summary: 'Delete product (admin). Past orders keep their item snapshot.',
          security: bearer,
          parameters: [idParam()],
          responses: { 200: ok(envelope({})), ...pick(401, 403, 404) },
        },
      },

      '/categories': {
        get: { tags: ['Categories'], summary: 'List categories', responses: { 200: ok(envelope({ categories: { type: 'array', items: ref('Category') } })) } },
      },

      '/cart/validate': {
        post: {
          tags: ['Cart'],
          summary: 'Live price and stock for cart items',
          requestBody: json({ type: 'object', required: ['items'], properties: { items: { type: 'array', items: ref('CartItem') } } }),
          responses: {
            200: ok(
              envelope({
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      productId: { type: 'string' },
                      quantity: { type: 'integer' },
                      available: { type: 'boolean' },
                      maxQuantity: { type: 'integer' },
                      message: { type: 'string', nullable: true },
                      product: { allOf: [ref('Product')], nullable: true },
                    },
                  },
                },
              }),
            ),
            ...pick(400),
          },
        },
      },

      '/orders': {
        post: {
          tags: ['Orders'],
          summary: 'Create a pending order. Prices and totals are computed from the database.',
          security: bearer,
          requestBody: json({
            type: 'object',
            required: ['items', 'shippingAddress', 'paymentMethod'],
            properties: {
              items: { type: 'array', minItems: 1, items: ref('CartItem') },
              shippingAddress: ref('ShippingAddress'),
              paymentMethod: { type: 'string', enum: ['paystack', 'flutterwave'] },
            },
          }),
          responses: { 201: ok(envelope({ order: ref('Order') }), 'Created'), ...pick(400, 401, 409, 429) },
        },
      },
      '/orders/my-orders': {
        get: {
          tags: ['Orders'],
          summary: "Signed-in customer's orders",
          security: bearer,
          parameters: pageParams,
          responses: { 200: ok(envelope({ orders: { type: 'array', items: ref('Order') }, pagination: ref('Pagination') })), ...pick(401) },
        },
      },
      '/orders/{id}': {
        get: {
          tags: ['Orders'],
          summary: 'Order detail (own orders; admins can read any)',
          security: bearer,
          parameters: [idParam()],
          responses: { 200: ok(envelope({ order: ref('Order') })), ...pick(401, 404) },
        },
      },
      '/orders/{id}/cancel': {
        post: {
          tags: ['Orders'],
          summary: 'Cancel your own unpaid order',
          security: bearer,
          parameters: [idParam()],
          responses: { 200: ok(envelope({ order: ref('Order') })), ...pick(400, 401, 404) },
        },
      },

      '/payments/paystack/initialize': {
        post: {
          tags: ['Payments'],
          summary: 'Start a Paystack payment for an order; returns the hosted checkout URL',
          security: bearer,
          requestBody: json({ type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', format: 'uuid' } } }),
          responses: { 200: ok(ref('PaymentInit')), ...pick(401, 404, 409, 429, 502, 503) },
        },
      },
      '/payments/paystack/verify/{reference}': {
        get: {
          tags: ['Payments'],
          summary: 'Verify with Paystack and settle the order (idempotent)',
          security: bearer,
          parameters: [{ name: 'reference', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: ok(ref('PaymentResult')), ...pick(400, 401, 404, 502) },
        },
      },
      '/payments/flutterwave/initialize': {
        post: {
          tags: ['Payments'],
          summary: 'Start a Flutterwave payment for an order; returns the hosted checkout URL',
          security: bearer,
          requestBody: json({ type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', format: 'uuid' } } }),
          responses: { 200: ok(ref('PaymentInit')), ...pick(401, 404, 409, 429, 502, 503) },
        },
      },
      '/payments/flutterwave/verify/{transactionId}': {
        get: {
          tags: ['Payments'],
          summary: 'Verify a Flutterwave transaction id and settle the order (idempotent)',
          security: bearer,
          parameters: [
            { name: 'transactionId', in: 'path', required: true, schema: { type: 'string', pattern: '^\\d+$' } },
            q('tx_ref', { type: 'string' }, 'Our reference from the redirect'),
          ],
          responses: { 200: ok(ref('PaymentResult')), ...pick(400, 401, 404, 502) },
        },
      },
      '/payments/flutterwave/verify-reference/{reference}': {
        get: {
          tags: ['Payments'],
          summary: 'Check a Flutterwave payment by our reference (e.g. after a cancelled checkout)',
          security: bearer,
          parameters: [{ name: 'reference', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: ok(ref('PaymentResult')), ...pick(401, 404, 502) },
        },
      },

      '/payments/paystack/webhook': {
        post: {
          tags: ['Webhooks'],
          summary: 'Paystack events. Requires x-paystack-signature (HMAC-SHA512 of the raw body).',
          parameters: [{ name: 'x-paystack-signature', in: 'header', required: true, schema: { type: 'string' } }],
          requestBody: json({ type: 'object', properties: { event: { type: 'string', example: 'charge.success' }, data: { type: 'object' } } }),
          responses: { 200: ok({ type: 'object', properties: { received: { type: 'boolean' } } }), 401: E[401] },
        },
      },
      '/payments/flutterwave/webhook': {
        post: {
          tags: ['Webhooks'],
          summary: 'Flutterwave events. Requires verif-hash equal to FLUTTERWAVE_WEBHOOK_HASH.',
          parameters: [{ name: 'verif-hash', in: 'header', required: true, schema: { type: 'string' } }],
          requestBody: json({ type: 'object', properties: { event: { type: 'string', example: 'charge.completed' }, data: { type: 'object' } } }),
          responses: { 200: ok({ type: 'object', properties: { received: { type: 'boolean' } } }), 401: E[401] },
        },
      },

      '/admin/stats': {
        get: { tags: ['Admin'], summary: 'Dashboard statistics', security: bearer, responses: { 200: ok(envelope({ stats: ref('Stats') })), ...pick(401, 403) } },
      },
      '/admin/products': {
        get: {
          tags: ['Admin'],
          summary: 'All products including hidden, with stock filters',
          security: bearer,
          parameters: [
            ...productQuery,
            q('status', { type: 'string', enum: ['active', 'hidden'] }),
            q('stock', { type: 'string', enum: ['in', 'low', 'out'] }),
          ],
          responses: { 200: ok(envelope({ products: { type: 'array', items: ref('Product') }, pagination: ref('Pagination') })), ...pick(401, 403) },
        },
      },
      '/admin/products/{id}': {
        get: { tags: ['Admin'], summary: 'Product detail (including hidden)', security: bearer, parameters: [idParam()], responses: { 200: ok(envelope({ product: ref('Product') })), ...pick(401, 403, 404) } },
      },
      '/admin/categories': {
        post: {
          tags: ['Admin'],
          summary: 'Create category',
          security: bearer,
          requestBody: json({ type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' } } }),
          responses: { 201: ok(envelope({ category: ref('Category') }), 'Created'), ...pick(400, 401, 403, 409) },
        },
      },
      '/admin/categories/{id}': {
        put: {
          tags: ['Admin'],
          summary: 'Update category',
          security: bearer,
          parameters: [idParam()],
          requestBody: json({ type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } }),
          responses: { 200: ok(envelope({ category: ref('Category') })), ...pick(400, 401, 403, 404, 409) },
        },
        delete: {
          tags: ['Admin'],
          summary: 'Delete category (its products become uncategorised)',
          security: bearer,
          parameters: [idParam()],
          responses: { 200: ok(envelope({})), ...pick(401, 403, 404) },
        },
      },
      '/admin/settings': {
        get: { tags: ['Admin'], summary: 'Store contact details', security: bearer, responses: { 200: ok(envelope({ settings: ref('StoreSettings') })), ...pick(401, 403) } },
        put: {
          tags: ['Admin'],
          summary: "Update store contact details (partial; '' clears a field). Shown in the footer and legal pages.",
          security: bearer,
          requestBody: json({ type: 'object', properties: { supportEmail: { type: 'string' }, supportPhone: { type: 'string' }, postalAddress: { type: 'string' } } }),
          responses: { 200: ok(envelope({ settings: ref('StoreSettings') })), ...pick(400, 401, 403) },
        },
      },
      '/admin/users': {
        get: {
          tags: ['Admin'],
          summary: 'All user accounts with last sign-in (newest first)',
          security: bearer,
          parameters: [
            q('role', { type: 'string', enum: ['customer', 'admin'] }),
            q('search', { type: 'string' }, 'Name, email or phone'),
            ...pageParams,
          ],
          responses: { 200: ok(envelope({ users: { type: 'array', items: ref('AdminUser') }, pagination: ref('Pagination') })), ...pick(400, 401, 403) },
        },
      },
      '/admin/users/{id}': {
        delete: {
          tags: ['Admin'],
          summary: 'Delete an account from Supabase Auth. Their orders are kept, detached from the account. The (single) admin account cannot be deleted.',
          security: bearer,
          parameters: [idParam()],
          responses: { 200: ok(envelope({})), ...pick(400, 401, 403, 404) },
        },
      },
      '/admin/orders': {
        get: {
          tags: ['Admin'],
          summary: 'All orders with filtering',
          security: bearer,
          parameters: [
            q('status', { type: 'string', enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'paid', 'failed', 'refunded', 'attention'] }, 'Order status; payment status for paid/failed/refunded; attention = flagged for admin review'),
            q('search', { type: 'string' }, 'Order number, customer, email or payment reference'),
            ...pageParams,
          ],
          responses: { 200: ok(envelope({ orders: { type: 'array', items: ref('Order') }, pagination: ref('Pagination') })), ...pick(400, 401, 403) },
        },
      },
      '/admin/orders/{id}': {
        get: { tags: ['Admin'], summary: 'Order detail with payment attempts', security: bearer, parameters: [idParam()], responses: { 200: ok(envelope({ order: ref('Order') })), ...pick(401, 403, 404) } },
      },
      '/admin/orders/{id}/status': {
        put: {
          tags: ['Admin'],
          summary: 'Advance fulfilment (pending → processing → shipped → delivered) or cancel',
          description: 'Only paid orders can be processed. Cancelling a paid order returns its stock; set refund=true to refund via the provider.',
          security: bearer,
          parameters: [idParam()],
          requestBody: json({
            type: 'object',
            required: ['status'],
            properties: {
              status: { type: 'string', enum: ['processing', 'shipped', 'delivered', 'cancelled'] },
              note: { type: 'string', maxLength: 500 },
              refund: { type: 'boolean', default: false },
            },
          }),
          responses: { 200: ok(envelope({ order: ref('Order') })), ...pick(400, 401, 403, 404) },
        },
      },
      '/admin/uploads': {
        post: {
          tags: ['Admin'],
          summary: `Upload product images to the configured storage provider (${env.STORAGE_PROVIDER})`,
          security: bearer,
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: { images: { type: 'array', maxItems: 6, items: { type: 'string', format: 'binary' } } },
                },
              },
            },
          },
          responses: { 201: ok(envelope({ images: { type: 'array', items: ref('Image') } }), 'Uploaded'), ...pick(400, 401, 403) },
        },
      },
    },
  };
}
