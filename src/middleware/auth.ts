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
    
    if (!token) {
      res.status(401).json({ error: 'No authentication token provided' });
      return;
    }

    // For development, you can temporarily bypass verification
    if (process.env.NODE_ENV === 'development' && process.env.SKIP_AUTH === 'true') {
      req.userId = extractMemberId(token) || 'dev_user';
      next();
      return;
    }

    const decoded = await verifyMemberstackToken(token);
    req.userId = decoded.id;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
