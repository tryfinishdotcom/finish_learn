import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { prisma } from '../config/database';

export const activityController = {
  // Get user's recent activity
  async getRecentActivity(req: AuthRequest, res: Response) {
    try {
      const memberId = req.userId!;
      const limit = parseInt(req.query.limit as string) || 10;

      const recentProgress = await prisma.lessonProgress.findMany({
        where: { memberId },
        orderBy: { updatedAt: 'desc' },
        take: limit
      });

      res.json({ success: true, data: recentProgress });
    } catch (error) {
      console.error('Get activity error:', error);
      res.status(500).json({ error: 'Failed to get activity' });
    }
  },

  // Get user stats
  async getUserStats(req: AuthRequest, res: Response) {
    try {
      const memberId = req.userId!;

      const [totalLessons, completedLessons, totalWatchTime, coursesStarted] = await Promise.all([
        prisma.lessonProgress.count({ where: { memberId } }),
        prisma.lessonProgress.count({ 
          where: { 
            memberId,
            percentComplete: { gte: 90 }
          } 
        }),
        prisma.lessonProgress.aggregate({
          where: { memberId },
          _sum: { secondsWatched: true }
        }),
        prisma.courseProgress.count({ where: { memberId } })
      ]);

      res.json({
        success: true,
        data: {
          totalLessons,
          completedLessons,
          totalWatchTime: totalWatchTime._sum.secondsWatched || 0,
          coursesStarted,
          completionRate: totalLessons > 0 
            ? Math.round((completedLessons / totalLessons) * 100) 
            : 0
        }
      });
    } catch (error) {
      console.error('Get stats error:', error);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  }
};
