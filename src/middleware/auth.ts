import { Request, Response, NextFunction } from 'express';
import { KeySourceUnavailableError, verifyMemberstackToken } from '../config/memberstack';

export interface AuthRequest extends Request {
  userId?: string;
}

type Env = Record<string, string | undefined>;
type AuthPath = 'verified_jwt' | 'member_id_fallback' | 'rejected' | 'key_source_unavailable';

// One line per authenticated request, so the share of each path can be counted from
// the logs. Never add the token or the member id to this line.
function logAuthPath(path: AuthPath): void {
  console.log(`[auth] auth_path=${path}`);
}

// Local development only: the learner id is taken from the request, unverified. Needs
// both NODE_ENV=development and AUTH_DEV_BYPASS=true, and is never on for a Railway
// deployment (Railway sets RAILWAY_ENVIRONMENT on every service).
export function devBypassEnabled(env: Env): boolean {
  return env.NODE_ENV === 'development' && env.AUTH_DEV_BYPASS === 'true' && !env.RAILWAY_ENVIRONMENT;
}

// Temporary, for the client cutover only: while AUTH_MEMBER_ID_FALLBACK_UNTIL holds a
// future UTC time (ISO 8601, at most 7 days ahead), a bare member id (`mem_…`) is still
// admitted as that learner. It proves nothing about who is calling, so it ends by
// itself at that time, can never run past FALLBACK_HARD_STOP whatever is configured,
// and is off when unset or unparseable. Remove this code after the cutover.
const FALLBACK_HARD_STOP = Date.parse('2026-11-30T23:59:59Z');
const FALLBACK_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type FallbackState = { on: true; until: Date } | { on: false; reason: 'unset' | 'invalid' | 'expired' | 'too_far' };

export function memberIdFallbackState(env: Env, now = Date.now()): FallbackState {
  const raw = env.AUTH_MEMBER_ID_FALLBACK_UNTIL;
  if (!raw) return { on: false, reason: 'unset' };
  const until = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(raw) ? Date.parse(raw) : NaN;
  if (Number.isNaN(until)) return { on: false, reason: 'invalid' };
  if (now >= until || now >= FALLBACK_HARD_STOP) return { on: false, reason: 'expired' };
  if (until - now > FALLBACK_MAX_WINDOW_MS) return { on: false, reason: 'too_far' };
  return { on: true, until: new Date(Math.min(until, FALLBACK_HARD_STOP)) };
}

// Logged once at startup, so the active mode can be read from the deploy log.
export function describeAuthMode(env: Env, now = Date.now()): string {
  if (devBypassEnabled(env)) return '[auth] mode=development_bypass (unverified, local only)';
  const fallback = memberIdFallbackState(env, now);
  return `[auth] mode=verified_token member_id_fallback=${
    fallback.on ? `on until=${fallback.until.toISOString()}` : `off (${fallback.reason})`
  }`;
}

function bearerToken(req: Request): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return match?.[1];
}

export async function authenticateUser(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = bearerToken(req);

    if (!token) {
      logAuthPath('rejected');
      res.status(401).json({ error: 'No authentication token provided' });
      return;
    }

    if (devBypassEnabled(process.env)) {
      const memberId = req.headers['x-member-id'];
      req.userId = (typeof memberId === 'string' && memberId) || token;
      next();
      return;
    }

    // The learner is whoever the verified token names. Nothing else in the request
    // (X-Member-ID, body, query) can choose the identity.
    let verifiedId: string | undefined;
    try {
      verifiedId = (await verifyMemberstackToken(token)).id;
    } catch (error) {
      if (error instanceof KeySourceUnavailableError) {
        console.error('[auth]', error.message);
        logAuthPath('key_source_unavailable');
        res.status(503).json({ error: 'Authentication temporarily unavailable' });
        return;
      }
    }

    if (verifiedId) {
      logAuthPath('verified_jwt');
      req.userId = verifiedId;
      next();
      return;
    }

    if (memberIdFallbackState(process.env).on && token.startsWith('mem_')) {
      logAuthPath('member_id_fallback');
      req.userId = token;
      next();
      return;
    }

    logAuthPath('rejected');
    res.status(401).json({ error: 'Invalid or expired token' });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}
