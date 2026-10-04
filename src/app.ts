// src/app.ts
import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';

import { initSentry } from './config/sentry';
import { errorHandler } from './middleware/errorHandler';
import { securityMiddleware } from './middleware/security';
import routes from './routes';

export function createApp(): Express {
  const app = express();

  // Trust proxy: two hops. On Railway a request reaches us as
  //   client -> CDN edge (152.233.x) -> Railway edge proxy -> app
  // and arrives with `X-Forwarded-For: <client>, <CDN edge>` from the Railway edge
  // (socket peer). Railway writes the header at its edge, so client-supplied values do
  // not survive. With 1 hop, req.ip was the CDN edge address and every learner shared
  // one rate-limit bucket (verified against production logs, 2026-10-04).
  app.set('trust proxy', 2);

  // Initialize Sentry
  initSentry(app);

  // Security middleware
  app.use(helmet());
  app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Member-ID'] // ADD X-Member-ID here
  }));

  // Body parsing and compression
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(compression());

  // Logging
  if (process.env.NODE_ENV === 'production') {
    app.use(morgan('combined'));
  } else if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('dev'));
  }

  // Security middleware
  app.use(securityMiddleware.rateLimiter);
  app.use(securityMiddleware.sanitizeInput);

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // API routes
  app.use('/api', routes);

  // Error handling
  app.use(errorHandler);

  return app;
}
