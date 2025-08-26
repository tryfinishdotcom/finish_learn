import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { prisma } from '../config/database';

export const progressController = {
  // Save or update lesson progress
  async saveLessonProgress(req: AuthRequest, res: Response) {
    try {
      const { lessonSlug, courseSlug, secondsWatched, totalDuration, percentComplete, url, title, headline, index } = req.body;
      const memberId = req.userId!;

      const progress = await prisma.lessonProgress.upsert({
        where: {
          memberId_lessonSlug: { memberId, lessonSlug }
        },
        update: {
          courseSlug,
          secondsWatched,
          totalDuration,
          percentComplete,
          lastPosition: secondsWatched,
          completedAt: percentComplete >= 90 ? new Date() : null
        },
        create: {
          memberId,
          lessonSlug,
          courseSlug,
          secondsWatched,
          totalDuration,
          percentComplete,
          lastPosition: secondsWatched,
          completedAt: percentComplete >= 90 ? new Date() : null
        }
      });

      // Also update course progress
      await prisma.courseProgress.upsert({
        where: {
          memberId_courseSlug: { memberId, courseSlug }
        },
        update: {
          lastLessonSlug: lessonSlug,
          lastLessonUrl: url,
          lastLessonTitle: title,
          lastLessonIndex: index,
          accessedAt: new Date()
        },
        create: {
          memberId,
          courseSlug,
          lastLessonSlug: lessonSlug,
          lastLessonUrl: url,
          lastLessonTitle: title,
          lastLessonIndex: index
        }
      });

      // Update global last lesson
      await prisma.userLastLesson.upsert({
        where: { memberId },
        update: {
          lessonSlug,
          courseSlug,
          url,
          title,
          headline,
          lessonIndex: index,
          accessedAt: new Date()
        },
        create: {
          memberId,
          lessonSlug,
          courseSlug,
          url,
          title,
          headline,
          lessonIndex: index
        }
      });

      res.json({ success: true, data: progress });
    } catch (error) {
      console.error('Save progress error:', error);
      res.status(500).json({ error: 'Failed to save progress' });
    }
  },

  // Get all lessons progress for user
  async getAllLessonsProgress(req: AuthRequest, res: Response) {
    try {
      const memberId = req.userId!;
      
      const progress = await prisma.lessonProgress.findMany({
        where: { memberId },
        orderBy: { updatedAt: 'desc' }
      });

      // Transform to match frontend format
      const progressByLesson: Record<string, any> = {};
      progress.forEach(p => {
        progressByLesson[p.lessonSlug] = {
          sec: p.secondsWatched,
          dur: p.totalDuration,
          percent: p.percentComplete,
          courseSlug: p.courseSlug,
          ts: p.updatedAt.getTime()
        };
      });

      res.json({ success: true, data: progressByLesson });
    } catch (error) {
      console.error('Get progress error:', error);
      res.status(500).json({ error: 'Failed to get progress' });
    }
  },

  // Get course progress
  async getCourseProgress(req: AuthRequest, res: Response) {
    try {
      const memberId = req.userId!;
      const { courseSlug } = req.params;

      const courseProgress = await prisma.courseProgress.findUnique({
        where: {
          memberId_courseSlug: { memberId, courseSlug }
        }
      });

      const lessonProgress = await prisma.lessonProgress.findMany({
        where: { memberId, courseSlug }
      });

      res.json({ 
        success: true, 
        data: {
          courseProgress,
          lessonProgress
        }
      });
    } catch (error) {
      console.error('Get course progress error:', error);
      res.status(500).json({ error: 'Failed to get course progress' });
    }
  }
};
