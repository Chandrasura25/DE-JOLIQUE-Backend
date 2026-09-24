import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import env, { clientOrigins, isProduction, isTest } from './config/env.js';
import routes from './routes/index.js';
import docsRoutes from './routes/docsRoutes.js';
import { apiLimiter } from './middleware/rateLimiters.js';
import { rejectUntrustedOrigin } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/error.js';
import { LOCAL_UPLOAD_DIR } from './services/storage.js';

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    helmet({
      // Product images may be served from this API to a storefront on another origin.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          fontSrc: ["'self'", 'data:'],
          // The storefront only talks to this API; Supabase Auth is called server-side.
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: isProduction ? [] : null,
        },
      },
    }),
  );

  app.use(
    '/api',
    cors({
      origin(origin, cb) {
        // Same-origin/server-to-server requests (and provider webhooks) have no Origin.
        if (!origin || clientOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      // The session travels in httpOnly cookies.
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

  app.use(compression());
  if (!isTest) app.use(morgan(isProduction ? 'combined' : 'dev'));

  // Keep the exact raw bytes: Paystack signs the raw webhook body.
  app.use(
    express.json({
      limit: '200kb',
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(cookieParser());

  if (env.STORAGE_PROVIDER === 'local') {
    app.use(
      '/uploads',
      express.static(LOCAL_UPLOAD_DIR, { maxAge: '30d', immutable: true, fallthrough: false, dotfiles: 'deny' }),
    );
  }

  // Swagger UI at /api/docs, raw OpenAPI spec at /api/docs.json
  app.use('/api', docsRoutes);
  app.use('/api', rejectUntrustedOrigin, apiLimiter, routes);
  app.use('/api', notFound);

  // Optional single-server deployment: serve the built React app.
  if (env.SERVE_CLIENT && fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
