import { Request, Response, NextFunction } from 'express';
import { verifyMemberstackToken, extractMemberId } from '../config/memberstack';

export interface AuthRequest extends Request {
  userId?: string;
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
    try {
      const decoded = await verifyMemberstackToken(token);
      req.userId = decoded.id;
      next();
    } catch (jwtError) {
      // Fallback: if JWT verification fails, use member ID directly
      // This handles the case where we're using member ID as token
      if (token.startsWith('mem_')) {
        req.userId = token;
        next();
      } else {
        res.status(401).json({ error: 'Invalid or expired token' });
      }
    }
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}
