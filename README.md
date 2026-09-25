# De-Jolique Enterprise — API

The backend for the De-Jolique Enterprise online store. It serves the product catalogue, runs checkout with **Paystack** or **Flutterwave**, manages orders and inventory, and handles all authentication through **Supabase Auth**. The storefront lives in a separate repository (`client/`).

| Layer | Technology |
| --- | --- |
| Runtime | **Node.js 22 + Express 4** |
| Database | **Supabase Postgres**, accessed with `pg`; schema managed with **Supabase CLI migrations** |
| Auth | **Supabase Auth** (email + password, Google, Google One Tap), driven entirely by this API; tokens kept in httpOnly cookies |
| Docs | **Swagger / OpenAPI 3** at `/api/docs` |
| Payments | Paystack, Flutterwave — initialised and **verified on the server** |
| Images | Supabase Storage (default), Cloudinary, AWS S3 / Cloudflare R2, or local disk |

---

## Contents

1. [Folder structure](#1-folder-structure)
2. [Getting started](#2-getting-started)
3. [Environment variables](#3-environment-variables)
4. [Supabase setup](#4-supabase-setup)
5. [Payment providers](#5-payment-providers)
6. [Image storage](#6-image-storage)
7. [Seeding and the admin account](#7-seeding-and-the-admin-account)
8. [Tests and CI](#8-tests-and-ci)
9. [API reference](#9-api-reference)
10. [How authentication works](#10-how-authentication-works)
11. [How payments and inventory stay correct](#11-how-payments-and-inventory-stay-correct)
12. [Security](#12-security)
13. [Deployment](#13-deployment)

---

## 1. Folder structure

```text
server/
├── src/
│   ├── config/                 # env.js (validated with zod), db.js (pg pool), supabase.js
│   ├── controllers/            # auth, user, product, category, order, payment, upload, config
│   ├── routes/                 # one router per resource + docsRoutes.js (Swagger)
│   ├── services/               # business logic: auth, users, products, orders, inventory, payments, storage
│   │   └── gateways/           # paystack.js, flutterwave.js
│   ├── middleware/             # auth (cookie session + refresh, admin role, CSRF origin check), validate, errors, rate limits, upload
│   ├── validators/schemas.js   # zod request schemas
│   ├── utils/                  # AppError, authCookies, helpers
│   ├── docs/openapi.js         # OpenAPI 3 spec (a test keeps it in sync with the routes)
│   ├── seed/                   # seed.js + sample data
│   ├── scripts/createAdmin.js
│   ├── app.js                  # Express app
│   └── index.js                # entry for local/long-running hosts (also runs the abandoned-order sweep)
├── api/index.js                # Vercel entry: exports the Express app as a serverless function
├── supabase/
│   ├── config.toml             # Supabase CLI config (local stack)
│   └── migrations/             # timestamped SQL migrations
├── tests/                      # integration tests (real Postgres + fake Supabase Auth)
├── .github/workflows/
│   ├── ci.yml                  # runs the test suite on every push and PR
│   └── supabase-migrations.yml # validates migrations on PRs, `supabase db push` on master
├── vercel.json                 # Vercel build, routing, region and daily cron
├── .env.example
└── package.json
```

### Database tables

| Table | Purpose |
| --- | --- |
| `profiles` | One row per Supabase Auth user: `name`, `email`, `phone`, `role` (`customer`/`admin`), `must_change_password`. Created by a trigger on `auth.users`. **At most one admin** (unique index). |
| `categories` | `name` (unique, case-insensitive), `slug`, `description` |
| `products` | `name`, `slug`, `description`, `price NUMERIC(12,2)`, `category_id`, `stock INTEGER CHECK (stock >= 0)`, `images JSONB`, `featured`, `is_active` |
| `orders` | `order_number` (`JQ-001001`), `user_id`, `shipping_address JSONB`, `payment_method`, `payment_reference`, `payment_status`, `order_status`, `subtotal`, `shipping_fee`, `total_amount`, `currency`, `inventory_committed`, timestamps |
| `order_items` | Product snapshot per line: `product_id`, `name`, `image`, `price`, `quantity`, `subtotal` |
| `order_status_history` | Timeline shown to customers and the admin |
| `store_settings` | Single row of admin-editable contact details (support email, phone, business address) shown in the footer and legal pages |
| `payments` | One row per payment attempt: `provider`, `reference` (**unique**), `provider_transaction_id`, `amount`, `amount_paid`, `currency`, `status`, `gateway_response`, `raw` |

---

## 2. Getting started

Requirements: **Node.js 22+**, npm, a **Supabase** project (the free tier is fine), and Paystack and/or Flutterwave test accounts. Docker is only needed to run Supabase locally.

```bash
npm install
cp .env.example .env         # then fill it in (section 3)
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push         # create the tables
npm run seed                 # sample catalogue + the admin account
npm run dev                  # http://localhost:5000 (restarts on changes)
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Start with auto-restart (`node --watch`) |
| `npm start` | Start for production |
| `npm test` | Run the integration test suite |
| `npm run seed` | Add sample categories, products and the admin (safe to re-run) |
| `npm run seed:reset` | **Delete** all orders, payments, products and categories, then seed (refuses in production) |
| `npm run create-admin` | Create or hand over the admin account (section 7) |

On startup the server checks the database connection and that the migrations have been applied.

- Health: <http://localhost:5000/api/health>
- **Swagger UI: <http://localhost:5000/api/docs>** (raw spec at `/api/docs.json`). It is **off in production** unless `API_DOCS=true`.

To try protected endpoints in Swagger, run **`POST /auth/login`** there first. It sets the session cookie, and the rest of the calls on the same page use it. Scripts can send `Authorization: Bearer <access_token>` instead.

---

## 3. Environment variables

**Never commit `.env`.** `.gitignore` excludes every `.env*` file except `.env.example`.

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | | `development` / `production` |
| `PORT` | | Port to listen on (default `5000`) |
| `CLIENT_URL` | ✔ | Storefront origin(s), comma-separated. Used for CORS, the CSRF origin check, and payment/sign-in redirects (the first one). |
| `SERVER_URL` | ✔ | Public URL the browser uses to reach this API. `<SERVER_URL>/api/auth/callback` is where Google and email links return. **Behind the Vercel `/api` proxy, this is the storefront URL** (section 13). |
| `DATABASE_URL` | ✔ | Supabase Postgres connection string (section 4) |
| `DATABASE_SSL` | | `true` for Supabase cloud, `false` for a local `supabase start` |
| `DATABASE_POOL_MAX` | | Connection pool size (default `10`; use `2`–`3` on Vercel) |
| `SUPABASE_URL` | ✔ | `https://<project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | ✔ | Used server-side for sign-in, sign-up, Google, refresh and password reset |
| `SUPABASE_SERVICE_ROLE_KEY` | ✔ | Server only. Auth Admin API (users, admin account) and Storage uploads |
| `GOOGLE_CLIENT_ID` | for One Tap | The Google OAuth **Web** client ID (public). Enables Google One Tap on the storefront. |
| `API_DOCS` | | `true` to serve Swagger UI at `/api/docs` in production (it's off there by default) |
| `AUTH_COOKIE_SAME_SITE` | | `lax` (default), `strict` or `none`. Only use `none` (HTTPS required) if the storefront calls the API cross-site without the proxy. |
| `TRUST_PROXY` | | Number of proxies in front of the API, so rate limits see real client IPs. `1` on Vercel, Render or Railway. |
| `SERVE_CLIENT` | | `true` to serve a built storefront from `../client/dist` (single-service deploy) |
| `STORE_NAME`, `CURRENCY` | | Defaults: `De-Jolique Enterprise`, `NGN` |
| `SHIPPING_FEE` | | Flat delivery fee added to each order (default `0`) |
| `LOW_STOCK_THRESHOLD` | | Low-stock warning level (default `5`) |
| `PENDING_ORDER_TTL_HOURS` | | Unpaid orders are cancelled after this many hours (default `48`, `0` disables) |
| `CRON_SECRET` | on Vercel | Long random string; Vercel Cron sends it to `/api/cron/expire-orders` |
| `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY` | one provider | Paystack keys |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_PUBLIC_KEY` | one provider | Flutterwave keys |
| `FLUTTERWAVE_WEBHOOK_HASH` | for FW webhooks | The "secret hash" set in the Flutterwave dashboard |
| `STORAGE_PROVIDER` | | `supabase` (default), `cloudinary`, `s3`, `local` |
| `SUPABASE_STORAGE_BUCKET` | | Default `product-images` |
| `CLOUDINARY_*` | if cloudinary | `CLOUD_NAME`, `API_KEY`, `API_SECRET`, `FOLDER` |
| `S3_*` | if s3 | `BUCKET`, `REGION`, `ENDPOINT` (R2), `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `PUBLIC_URL` |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | | The admin account created by `npm run seed` |

The server validates its configuration at startup and exits with a clear message if something required is missing. A payment provider without a secret key is simply hidden at checkout. No JWT secret is needed: access tokens are verified against the project's published signing keys (JWKS).

---

## 4. Supabase setup

### 4.1 Credentials

1. Create a project at <https://supabase.com/dashboard> and save the **database password**.
2. **Project Settings → API**: copy the **Project URL**, the **anon** key and the **service_role** key into `.env`.
3. **Connect** (top of the dashboard) → **Session pooler**: copy the URI into `DATABASE_URL`, replacing `[YOUR-PASSWORD]`. The direct connection is IPv6-only on many networks; the pooler works everywhere.

### 4.2 Migrations

The schema lives in `supabase/migrations/*.sql` and is applied with the official CLI, which records what has run in `supabase_migrations.schema_migrations`.

```bash
npx supabase db push                               # apply pending migrations
npx supabase migration list                        # local vs remote status
npx supabase migration new add_product_reviews     # start a new migration
```

The migrations create every store table, constraint, index and `updated_at` trigger, plus:

- a trigger on `auth.users` that creates a `customer` profile at sign-up (the role is **never** read from user metadata)
- **Row Level Security on every table with no policies**, so the public anon key cannot read or write store data through Supabase's auto-generated API. Only this API (connecting as the database owner) can.
- the single-admin unique index
- a public-read `product-images` storage bucket (uploads only through the service role)

### 4.3 GitHub Action for migrations

`.github/workflows/supabase-migrations.yml` validates migrations on pull requests (fresh Postgres, apply all, lint) and runs `supabase db push` on pushes to `master`. Add these repository secrets and create a `production` environment (you can require manual approval there):

| Secret | Where to find it |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | <https://supabase.com/dashboard/account/tokens> |
| `SUPABASE_DB_PASSWORD` | Your project's database password |
| `SUPABASE_PROJECT_ID` | The project ref (the `xxxx` in `https://xxxx.supabase.co`) |

### 4.4 Auth settings

- **Authentication → URL Configuration:** set **Site URL** to the storefront, and add `<SERVER_URL>/api/auth/callback**` to **Redirect URLs**, for example `http://localhost:5000/api/auth/callback**` locally and `https://<storefront-domain>/api/auth/callback**` behind the Vercel proxy. Google, email-confirmation and password-reset links all return there.
- **Google sign-in:** create an OAuth client (type *Web application*) in Google Cloud Console → APIs & Services → Credentials, with `https://<project-ref>.supabase.co/auth/v1/callback` as the authorised redirect URI. Paste its client ID and secret into **Authentication → Sign In / Providers → Google** and enable it. The storefront shows "Continue with Google" automatically once it's on (the API checks every few minutes).
- **Google One Tap:** on the same Google OAuth client, add your storefront origins (`http://localhost:5173`, `https://<storefront-domain>`) under **Authorised JavaScript origins**, then set `GOOGLE_CLIENT_ID` on the API to that client ID. Leave **Skip nonce checks** *off* in Supabase's Google provider settings: the nonce is what ties each One Tap token to the browser it was issued to.
- **Email confirmation** is on by default. New customers must click the link before they can log in. You can switch it off under **Authentication → Providers → Email** while developing.

### 4.5 Optional: run Supabase locally

```bash
npx supabase start          # local Postgres, Auth, Storage, Studio (Docker required)
npx supabase db reset       # re-apply every migration to the local database
```

Then use the printed values: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`, `DATABASE_SSL=false`, `SUPABASE_URL=http://127.0.0.1:54321`, and the printed keys. Local emails appear in Mailpit at <http://127.0.0.1:54324>.

---

## 5. Payment providers

**Paystack:** Dashboard → **Settings → API Keys & Webhooks**. Copy the secret and public keys, and set the webhook URL to `<SERVER_URL>/api/payments/paystack/webhook`. Webhooks are authenticated with the `x-paystack-signature` header (HMAC-SHA512 of the raw body).

**Flutterwave:** Dashboard → **Settings → API Keys**, then **Settings → Webhooks**. Set the URL to `<SERVER_URL>/api/payments/flutterwave/webhook` and a long random **Secret hash**, and put the same value in `FLUTTERWAVE_WEBHOOK_HASH`.

Both providers get the return URL per transaction (`<CLIENT_URL>/payment/callback?...`), so there is nothing else to configure. Without webhooks everything still works, because the redirect back to the store triggers the same server-side verification. To receive webhooks locally, expose the API with a tunnel (e.g. `ngrok http 5000`).

**Test cards:** Paystack `4084 0840 8408 4081`, any future expiry, CVV `408`, PIN `0000`, OTP `123456`. Flutterwave `5531 8866 5214 2950`, expiry `09/32`, CVV `564`, PIN `3310`, OTP `12345`.

---

## 6. Image storage

Admin uploads go through `POST /api/admin/uploads`, one image per request (Vercel caps a request body at 4.5 MB). Files are held in memory, checked by their **real file signature** (JPEG/PNG/WebP/GIF, ≤ 4 MB), then sent to the configured provider. Only the URL and key are stored on the product.

| `STORAGE_PROVIDER` | Setup |
| --- | --- |
| `supabase` (default) | Nothing extra: uses `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` and the `product-images` bucket |
| `cloudinary` | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` |
| `s3` (AWS S3 / Cloudflare R2) | `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL`; for R2 also `S3_ENDPOINT` and `S3_REGION=auto` |
| `local` | **Development only.** Files go to `uploads/` (git-ignored) and are served at `/uploads/*`. Most hosts wipe the disk on redeploy. |

---

## 7. Seeding and the admin account

```bash
npm run seed          # 5 categories, 24 sample products and the admin account
```

The seeded admin is `ADMIN_EMAIL` / `ADMIN_PASSWORD` (defaults `admin@jolique.com` / `ChangeMe123!`). **Change the password on first login.** The account is flagged `must_change_password`, and every admin API returns `403 PASSWORD_CHANGE_REQUIRED` until it's changed. Set your own values before seeding a real store.

The store has **exactly one admin**. A unique index makes a second one impossible, and the admin can't be deleted from the dashboard.

```bash
npm run create-admin -- --email owner@example.com --password "Str0ngPassw0rd" --name "Store Owner"
```

This creates the account in Supabase Auth (email pre-confirmed) or promotes an existing one. If someone else is already the admin, it refuses; add `--replace` to hand the role over (the previous admin becomes a customer). `npm run seed` leaves an existing admin alone.

---

## 8. Tests and CI

```bash
npm test
```

The integration tests run against a **real Postgres** (started automatically with `embedded-postgres`) with the actual `supabase/migrations` applied, plus a small local fake of Supabase Auth (ES256 JWKS, password/refresh/PKCE grants, sign-up, recovery, admin users). Only the outbound calls to Paystack and Flutterwave are replaced. They cover:

- **auth:** cookie sessions (register, login, transparent refresh with rotation, logout revocation), Google and email-link callbacks, One Tap nonce binding and replay, the password-guessing lockout, no account enumeration on register, recovery-only password reset, CSRF origin check, open-redirect guard, forged/expired/wrong-issuer tokens, role injection through metadata
- **admin:** role checks, the single-admin rule and `create-admin --replace`, user listing with last sign-in, user deletion that keeps order history
- **products, orders, payments:** search/filter/sort, injection attempts, server-side pricing, stock limits, idempotent verification, **two buyers racing for the last unit**, webhook signatures and replays, refunds, abandoned-order expiry
- **docs:** every Express route is in the OpenAPI spec, and vice versa

`.github/workflows/ci.yml` runs the suite on every push and pull request.

---

## 9. API reference

Full, interactive documentation: **`/api/docs`**. Summary:

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/health`, `/api/config` | public |
| GET | `/api/cron/expire-orders` | Vercel Cron (`CRON_SECRET`) |
| GET | `/api/auth/providers` | public |
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/forgot-password` | public (rate-limited) |
| POST | `/api/auth/logout` | public |
| GET | `/api/auth/google`, `/api/auth/callback` | browser redirects |
| GET, POST | `/api/auth/google/one-tap/nonce`, `/api/auth/google/one-tap` | public (rate-limited) |
| POST | `/api/auth/reset-password` | recovery-link session |
| GET / PUT | `/api/auth/me` | signed in |
| PUT | `/api/auth/change-password` | signed in (rate-limited) |
| GET | `/api/products`, `/api/products/:idOrSlug`, `/api/categories` | public |
| POST / PUT / DELETE | `/api/products`, `/api/products/:id` | admin |
| POST | `/api/cart/validate` | public |
| POST | `/api/orders` | customer |
| GET | `/api/orders/my-orders`, `/api/orders/:id` | customer (own orders) |
| POST | `/api/orders/:id/cancel` | customer (unpaid only) |
| POST | `/api/payments/paystack/initialize`, `/api/payments/flutterwave/initialize` | customer |
| GET | `/api/payments/paystack/verify/:reference` | customer |
| GET | `/api/payments/flutterwave/verify/:transactionId`, `/api/payments/flutterwave/verify-reference/:reference` | customer |
| POST | `/api/payments/paystack/webhook`, `/api/payments/flutterwave/webhook` | provider signature |
| GET | `/api/admin/stats`, `/api/admin/products`, `/api/admin/products/:id` | admin |
| POST / PUT / DELETE | `/api/admin/categories[/:id]` | admin |
| GET | `/api/admin/orders`, `/api/admin/orders/:id` | admin |
| PUT | `/api/admin/orders/:id/status` | admin |
| GET / PUT | `/api/admin/settings` | admin (store contact email, phone, address) |
| GET | `/api/admin/users` | admin |
| DELETE | `/api/admin/users/:id` | admin (customers only) |
| POST | `/api/admin/uploads` | admin |

Errors always look like `{ "success": false, "message": "…", "details"?: [...] }` with a meaningful HTTP status. Stack traces are never returned.

---

## 10. How authentication works

- The storefront never talks to Supabase. It calls `/api/auth/*`, and this API calls Supabase Auth.
- The Supabase **access and refresh tokens live in httpOnly cookies** (`jq_access`, `jq_refresh`, path `/api`), so browser JavaScript never sees them.
- When the access token has expired, the next request refreshes it with the refresh token and writes the new pair back. The refresh token rotates on every use.
- Google, email-confirmation and password-reset links use **PKCE**. The verifier waits in a short-lived httpOnly cookie until `/api/auth/callback` exchanges the code, so a link must be opened in the browser that requested it.
- **Google One Tap:** the API issues a fresh random nonce per prompt and keeps the raw value in an httpOnly cookie. The browser only gets its SHA-256, which Google embeds in the ID token. `POST /api/auth/google/one-tap` redeems the token with Supabase using the raw nonce, once, so a leaked One Tap token can't be replayed from anywhere else.
- Setting a new password from a reset link only works in a session that was opened by that link within the last hour.
- **Password guessing** is limited in the database, so the limits hold across every serverless instance. After 10 failures in 15 minutes an account's password login pauses for 15 minutes (Google sign-in and password reset still work), and 50 failures from one IP block that IP for 15 minutes.
- **Existing emails:** registering with an email that is already in use returns `409` with a clear message (a deliberate product choice, so it does reveal which emails have accounts; the auth rate limiter slows bulk probing). Login also says whether the email has no account, is Google-only, or had the wrong password. Forgot-password always answers the same way.
- Logout revokes the session in Supabase and clears the cookies. Deleting a user signs them out everywhere at once.
- The role is read from `public.profiles` on every request, never from the token.

---

## 11. How payments and inventory stay correct

```text
Customer ─► POST /api/orders ───────────► server re-prices every item from the DB, creates order (pending/pending)
        ─► POST /payments/<p>/initialize ► server re-checks stock, records a payment attempt with a new reference,
                                           asks the provider for a hosted checkout URL (amount = stored order total)
        ─► pays on Paystack/Flutterwave
        ─► redirected to /payment/callback ─► GET /payments/<p>/verify/…  ┐
Provider ─► POST /payments/<p>/webhook (signature checked) ───────────────┴► processPayment():
      1. ask the provider's verify API for the real status   (never trust the browser or webhook body)
      2. check reference, currency, and amount paid ≥ order total
      3. BEGIN; SELECT … FOR UPDATE on the payment row and the order row
      4. if already settled → return the result (idempotent)
      5. UPDATE products SET stock = stock - q WHERE id = … AND stock >= q   (per item, inside a savepoint)
         · every item succeeds → order paid, inventory_committed = true
         · any item fails (sold out meanwhile) → roll back to savepoint, cancel order, refund via provider
      6. record the payment (status, amount paid, provider transaction id); COMMIT
```

- **Concurrency.** The conditional `UPDATE … WHERE stock >= q` takes a row lock, so when two buyers race for the last unit, the second matches no rows. `CHECK (stock >= 0)` backs this up.
- **Failed payments never touch stock.** Stock is only deducted after a verified success.
- **Abandoned orders.** Unpaid orders older than `PENDING_ORDER_TTL_HOURS` are checked with the provider. They are settled if they were actually paid (the redirect and the webhook both failed), and cancelled otherwise. Stock is never held by unpaid orders, so this is housekeeping plus a safety net. It runs every 30 minutes under `npm start`, and once a day via Vercel Cron on Vercel.
- **Anything unusual** (a duplicate payment, a payment for a cancelled order, a failed refund) is flagged `requires_attention` and shown on the admin dashboard.

---

## 12. Security

What protects customers' accounts, data and payments, and the few settings you must get right.

**Tokens and sessions**
- Supabase access and refresh tokens live only in **httpOnly, Secure, SameSite** cookies scoped to `/api`. They're never in a response body, `localStorage` or a URL.
- Access tokens are verified on every request (signature via JWKS, issuer, audience, expiry). The role is read from the database, never from the token.
- Refresh tokens rotate on every use. Logout revokes the session in Supabase, and deleting a user ends their sessions immediately.
- **CSRF:** a state-changing request whose `Origin` isn't the storefront is rejected. Google, email-link and One Tap flows are bound to the browser that started them (PKCE verifier or nonce in an httpOnly cookie).
- Redirects after sign-in only go to same-site paths (no open redirects).

**Customer data (emails, addresses, orders)**
- **Row Level Security on every table, with no policies.** Supabase's public Data API returns nothing even with the public anon key (checked against the live project). Only this API, connecting as the database owner, can read data.
- Customers only ever get their own orders; admin endpoints re-check the role from the database on every call. There is exactly one admin, and that account can't be deleted.
- No account enumeration through register or forgot-password.
- Logs record paths only, never query strings, so one-time auth codes and payment references stay out of them. Error responses never include stack traces or SQL.

**Payments**
- Totals are computed on the server from database prices; whatever the browser sends is ignored.
- A payment only counts after the server asks Paystack/Flutterwave directly. Webhook signatures are checked in constant time, and even a correctly signed webhook is re-verified with the provider.
- Stock and payment updates are transactional and idempotent. Secret keys never leave the server.

**Abuse and hardening**
- Rate limits: in-memory per instance for general traffic, plus the database-backed password-guessing limits.
- Every body, query and path parameter is validated and whitelisted with zod, and every SQL query is parameterised.
- Uploads are admin-only, size-limited and checked by file signature.
- Helmet sets CSP, HSTS, `frame-ancestors 'none'` and the other security headers on the API. The storefront's `vercel.json` sets matching headers, including a strict CSP.
- Swagger UI is off in production. Dependencies have no known vulnerabilities (`npm audit`).

### Before going live: settings only you can change

| Where | Setting | Why |
| --- | --- | --- |
| Supabase → Settings → Database | **Reset the database password**, then update `DATABASE_URL` everywhere | Rotate any credential that has ever appeared in chat, a screenshot or a terminal log |
| Supabase → Settings → API | Keep the **service_role** key only in the API's environment variables | It bypasses every security rule |
| Supabase → Authentication → Rate Limits | **Raise the sign-in, sign-up and token-refresh limits** | All auth calls come from the API's servers, so Supabase counts every customer against the same few IPs. The defaults are sized for one browser, and a busy day would lock everyone out. |
| Supabase → Authentication → Providers → Email | Keep **Confirm email** and **Secure email change** on; minimum password length 8; **Password requirements**: lowercase, uppercase letters, digits and symbols | Stops sign-ups with other people's emails |
| Supabase → Authentication → Providers → Email | Turn on **leaked password protection** (Pro plan) | Rejects passwords known from breaches |
| Supabase → Authentication → URL Configuration | Redirect URLs: **only** your own `…/api/auth/callback**` entries | Stops auth links being sent anywhere else |
| Supabase → Authentication → Multi-Factor | Plan to require MFA for the admin account | The admin can see every customer's details |
| Paystack / Flutterwave | Enable 2FA on the dashboards; use live keys only in production | They hold the money |
| Vercel (both projects) | Enable 2FA and limit team members | Anyone with Vercel access can read the environment variables |
| Vercel → Firewall | Add a rate-limit rule for `/api/auth/*` | A second layer against bots, in front of the API |
| Seeded admin | Change `ChangeMe123!` on first login (it's forced) | |

---

## 13. Deployment

### Vercel (the setup this repo is configured for)

`vercel.json` deploys **only** `api/index.js` as a Node serverless function (the `builds` entry). Every path is routed to it, so no project file is ever served as a static file. It also bundles Swagger UI's assets, pins the function to **`fra1`** (Frankfurt, next to the Supabase database in `eu-central-1`), and schedules the abandoned-order cron.

1. **Database:** `npx supabase db push` (or merge to `master` and let the GitHub Action do it), then `npm run seed` once, or just `npm run create-admin`, from your machine against the production database.
2. **Create the Vercel project** from this repository. There is no build step, and the framework preset is ignored because `vercel.json` defines the build.
3. **Environment variables** (Project → Settings → Environment Variables): everything from `.env.example`, plus:
   - `NODE_ENV=production`, `TRUST_PROXY=1`, live payment keys
   - `DATABASE_URL`: the Supabase **transaction pooler** URI (port `6543`), with `DATABASE_POOL_MAX=3`. Serverless functions open many short-lived connections, which is what the transaction pooler is for.
   - `CRON_SECRET`: a long random string (`openssl rand -hex 32`)
   - `STORAGE_PROVIDER=supabase` (or cloudinary / s3). **Not `local`**: a function's disk isn't kept.
   - `CLIENT_URL` and `SERVER_URL`: both set to the **storefront** URL (see below)
4. **Storefront proxy:** the storefront's `vercel.json` forwards `/api/*` to this project's domain (`https://<api-project>.vercel.app`). The browser only ever talks to the storefront domain, so session cookies are first-party (Safari keeps working) and `AUTH_COOKIE_SAME_SITE` can stay `lax`. That's why `SERVER_URL` is the storefront URL: Google and email links must return through the proxy to set cookies on the right domain.
5. **Supabase Auth:** set Site URL to `https://<storefront-domain>` and add `https://<storefront-domain>/api/auth/callback**` to Redirect URLs.
6. **Payment webhooks:** `https://<api-project>.vercel.app/api/payments/paystack/webhook` and `…/flutterwave/webhook`.
7. Log in at `/admin/login` and change the seeded password.

**Serverless limits to know about**

- **Cron frequency:** the Hobby plan runs crons at most once a day, hence `0 3 * * *` (03:00 UTC). On Pro you can make it hourly (`0 * * * *`).
- **Uploads:** request bodies are capped at 4.5 MB. The admin uploads images one per request, up to 4 MB each.
- **Rate limits** are counted per function instance, so under heavy traffic they are looser than the numbers in `src/middleware/rateLimiters.js`. For strict limits, use Vercel's firewall rules.

### Any long-running Node host (Render, Railway, Fly.io, a VPS)

Build `npm ci`, start `npm start` (`src/index.js`). The abandoned-order sweep then runs every 30 minutes by itself, so no `CRON_SECRET` is needed. The environment is the same as above, except `TRUST_PROXY` is the number of proxies in front of the app, and the session pooler (port `5432`) with the default pool size is fine.

*Single-service alternative:* deploy the `client/` folder next to this one, build it, and run the API with `SERVE_CLIENT=true`. It then serves the storefront and the API from one origin.
