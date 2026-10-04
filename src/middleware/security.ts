// src/middleware/security.ts
import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

type Env = Record<string, string | undefined>;

// The lesson player saves progress every 5 s while a video plays (~180 saves per
// 15 min, plus saves on pause/seek), so saves get their own per-client budget instead
// of sharing the general one. Same window as the general limiter.
export function progressSaveLimit(env: Env): { windowMs: number; max: number } {
  return {
    windowMs: parseInt(env.RATE_LIMIT_WINDOW_MS || '900000'),
    max: parseInt(env.RATE_LIMIT_PROGRESS_MAX_REQUESTS || '600'),
  };
}

// POST /api/progress/lesson, matched the way Express routes it (case-insensitive,
// optional trailing slash), so no variant escapes both limiters.
function isProgressSave(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const path = req.path.toLowerCase().replace(/\/+$/, '');
  return path === '/api/progress/lesson';
}

// Both limiters key on req.ip (the library default): the client address resolved by the
// app's 'trust proxy' hop count, see src/app.ts. Never parse X-Forwarded-For by hand
// here: its rightmost entry is Railway's CDN edge, shared by every learner.
const rateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  // Health checks are not limited; progress saves have their own limiter below.
  skip: (req: Request) => req.path === '/health' || isProgressSave(req)
});

const progressSaveRateLimiter = rateLimit({
  ...progressSaveLimit(process.env),
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => !isProgressSave(req)
});

// Basic input sanitization
function sanitizeInput(req: Request, res: Response, next: NextFunction) {
  // Sanitize body
  if (req.body && typeof req.body === 'object') {
    sanitizeObject(req.body);
  }
  
  // Sanitize query
  if (req.query && typeof req.query === 'object') {
    sanitizeObject(req.query);
  }
  
  // Sanitize params
  if (req.params && typeof req.params === 'object') {
    sanitizeObject(req.params);
  }
  
  next();
}

function sanitizeObject(obj: any) {
  for (const key in obj) {
    if (typeof obj[key] === 'string') {
      // Remove null bytes
      obj[key] = obj[key].replace(/\0/g, '');
      // Trim whitespace
      obj[key] = obj[key].trim();
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      sanitizeObject(obj[key]);
    }
  }
}

export const securityMiddleware = {
  rateLimiter,
  progressSaveRateLimiter,
  sanitizeInput
};
