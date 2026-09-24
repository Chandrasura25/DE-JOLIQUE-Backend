import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import env, { apiDocsEnabled, clientOrigins, isProduction, isTest } from './config/env.js';
import routes from './routes/index.js';
import docsRoutes from './routes/docsRoutes.js';
import { apiLimiter } from './middleware/rateLimiters.js';
import { rejectUntrustedOrigin } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/error.js';
import { LOCAL_UPLOAD_DIR } from './services/storage.js';

const GSI = 'https://accounts.google.com/gsi/';

morgan.token('path', (req) => req.originalUrl.split('?')[0]);

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // No ETag revalidation for API responses: a 304 carries no CORS headers, so the
  // browser would reuse a stale Access-Control-Allow-Origin from its cached copy.
  app.set('etag', false);
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    helmet({
      // Product images may be served from this API to a storefront on another origin.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // accounts.google.com/gsi: Google One Tap (when SERVE_CLIENT serves the storefront).
          scriptSrc: ["'self'", GSI],
          styleSrc: ["'self'", "'unsafe-inline'", GSI],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          fontSrc: ["'self'", 'data:'],
          // The storefront only talks to this API; Supabase Auth is called server-side.
          connectSrc: ["'self'", GSI],
          frameSrc: [GSI],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
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

  // API responses are per-user and change constantly: never let a browser or CDN cache
  // them (a cached reply can also carry a stale Access-Control-Allow-Origin).
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use(compression());
  // Paths only: query strings can carry one-time auth codes and payment references.
  if (!isTest) {
    app.use(
      morgan(
        isProduction
          ? ':remote-addr [:date[iso]] ":method :path" :status :res[content-length] - :response-time ms'
          : ':method :path :status :response-time ms',
      ),
    );
  }

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

  // Swagger UI at /api/docs, raw OpenAPI spec at /api/docs.json. Off in production
  // unless API_DOCS=true: a public map of every endpoint only helps attackers.
  if (apiDocsEnabled) app.use('/api', docsRoutes);
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
