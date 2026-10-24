import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { prisma } from '../config/database';

export const progressController = {
  // Save or update lesson progress
  async saveLessonProgress(req: AuthRequest, res: Response) {
    try {
      const { lessonSlug, courseSlug, secondsWatched, totalDuration, percentComplete, url, title, headline, index } = req.body;
      const memberId = req.userId!;

      // Progress never moves backwards: a late or replayed save with lower values (an old
      // tab, a queued retry) keeps the higher values already stored, and a lesson stays
      // completed once completed. One atomic statement, so concurrent saves cannot race.
      const completedAt = Number(percentComplete) >= 90 ? new Date() : null;
      const [progress] = await prisma.$queryRaw<Record<string, unknown>[]>`
        INSERT INTO lesson_progress
          (member_id, lesson_slug, course_slug, seconds_watched, total_duration, percent_complete,
           last_position, completed_at, created_at, updated_at)
        VALUES (${memberId}, ${lessonSlug}, ${courseSlug}, ${secondsWatched}::int, ${totalDuration}::int,
          ${percentComplete}::int, ${secondsWatched}::int, ${completedAt}, now(), now())
        ON CONFLICT (member_id, lesson_slug) DO UPDATE SET
          course_slug = EXCLUDED.course_slug,
          seconds_watched = GREATEST(lesson_progress.seconds_watched, EXCLUDED.seconds_watched),
          total_duration = GREATEST(lesson_progress.total_duration, EXCLUDED.total_duration),
          percent_complete = GREATEST(lesson_progress.percent_complete, EXCLUDED.percent_complete),
          last_position = GREATEST(lesson_progress.last_position, EXCLUDED.last_position),
          completed_at = COALESCE(lesson_progress.completed_at, EXCLUDED.completed_at),
          updated_at = now()
        RETURNING id, member_id AS "memberId", lesson_slug AS "lessonSlug", course_slug AS "courseSlug",
          seconds_watched AS "secondsWatched", total_duration AS "totalDuration",
          percent_complete AS "percentComplete", last_position AS "lastPosition",
          completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

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
