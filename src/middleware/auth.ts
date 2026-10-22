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
// NODE_ENV=development and is never on for a Railway deployment (Railway sets
// RAILWAY_ENVIRONMENT on every service), whatever else is configured.
export function devBypassEnabled(env: Env): boolean {
  return env.NODE_ENV === 'development' && !env.RAILWAY_ENVIRONMENT;
}

// Temporary, for the client cutover only: while AUTH_ALLOW_MEMBER_ID_FALLBACK is exactly
// 'true', a bare member id (`mem_…`) is still admitted as that learner. It proves
// nothing about who is calling, so it is off unless set, and must be removed once the
// learning app sends Memberstack tokens.
export function memberIdFallbackEnabled(env: Env): boolean {
  return env.AUTH_ALLOW_MEMBER_ID_FALLBACK === 'true';
}

// Logged once at startup, so the active mode can be read from the deploy log.
export function describeAuthMode(env: Env): string {
  if (devBypassEnabled(env)) return '[auth] mode=development_bypass (unverified, local only)';
  return `[auth] mode=verified_token member_id_fallback=${memberIdFallbackEnabled(env) ? 'on' : 'off'}`;
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

    if (memberIdFallbackEnabled(process.env) && token.startsWith('mem_')) {
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
