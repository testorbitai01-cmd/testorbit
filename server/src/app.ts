import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { apiRouter } from './routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          // The face detector (MediaPipe) is self-hosted WebAssembly; wasm compilation needs this, not 'unsafe-eval'.
          'script-src': ["'self'", "'wasm-unsafe-eval'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'media-src': ["'self'", 'blob:'],
          'connect-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'font-src': ["'self'", 'data:'],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'upgrade-insecure-requests': env.isProduction ? [] : null,
        },
      },
      // Camera/mic are used by this origin only.
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
    next();
  });

  // Health check for Railway (no auth, no secrets).
  app.get('/api/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', database: 'ok', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unreachable', time: new Date().toISOString() });
    }
  });

  app.use('/api', apiLimiter);
  app.use('/api', cookieParser());
  app.use('/api', express.json({ limit: '2mb' }));
  app.use('/api', csrfProtection);
  app.use('/api', (_req, res, next) => {
    // API responses may contain personal data; never cache them.
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', apiRouter);
  app.use('/api', notFoundHandler);

  // Production: serve the built React app and fall back to index.html for client routes.
  if (fs.existsSync(path.join(env.clientDistDir, 'index.html'))) {
    app.use(
      express.static(env.clientDistDir, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(env.clientDistDir, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
