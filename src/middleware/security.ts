// src/middleware/security.ts
import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

// Rate limiter
const rateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed on req.ip (the library default): the client address resolved by the app's
  // 'trust proxy' hop count, see src/app.ts. Never parse X-Forwarded-For by hand here:
  // its rightmost entry is Railway's CDN edge, shared by every learner.
  skip: (req: Request) => {
    // Skip rate limiting for health checks
    return req.path === '/health';
  }
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
  sanitizeInput
};
