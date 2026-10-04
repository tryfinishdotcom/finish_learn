import { Request, Response, NextFunction } from 'express';
import { verifyMemberstackToken } from '../config/memberstack';

export interface AuthRequest extends Request {
  userId?: string;
}

type AuthPath = 'verified_jwt' | 'member_id_fallback' | 'rejected';

// One line per authenticated request, so the share of each path can be counted from
// the logs. Never add the token or the member id to this line.
function logAuthPath(path: AuthPath): void {
  console.log(`[auth] auth_path=${path}`);
}

export async function authenticateUser(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const memberId = req.headers['x-member-id'] as string;

    if (!token) {
      logAuthPath('rejected');
      res.status(401).json({ error: 'No authentication token provided' });
      return;
    }

    // For development or when using member ID directly
    if (process.env.NODE_ENV === 'development' || process.env.SKIP_AUTH === 'true') {
      // Use member ID from header or token
      req.userId = memberId || token;
      next();
      return;
    }

    // For production, verify the actual JWT token when available
    let verifiedId: string | undefined;
    try {
      verifiedId = (await verifyMemberstackToken(token)).id;
    } catch {
      verifiedId = undefined;
    }

    if (verifiedId) {
      logAuthPath('verified_jwt');
      req.userId = verifiedId;
      next();
      return;
    }

    // Fallback: if JWT verification fails, use member ID directly
    // This handles the case where we're using member ID as token
    if (token.startsWith('mem_')) {
      logAuthPath('member_id_fallback');
      req.userId = token;
      next();
    } else {
      logAuthPath('rejected');
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}
