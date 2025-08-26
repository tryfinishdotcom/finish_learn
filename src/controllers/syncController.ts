import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { prisma } from '../config/database';

export const syncController = {
  async syncAll(req: AuthRequest, res: Response) {
    try {
      const memberId = req.userId!;

      const [lessonProgress, courseProgress, todos, lastLesson] = await Promise.all([
        prisma.lessonProgress.findMany({ where: { memberId } }),
        prisma.courseProgress.findMany({ where: { memberId } }),
        prisma.lessonTodo.findMany({ where: { memberId } }),
        prisma.userLastLesson.findUnique({ where: { memberId } })
      ]);

      // Transform to frontend format
      const progressByLesson: Record<string, any> = {};
      lessonProgress.forEach(p => {
        progressByLesson[p.lessonSlug] = {
          sec: p.secondsWatched,
          dur: p.totalDuration,
          percent: p.percentComplete,
          courseSlug: p.courseSlug,
          ts: p.updatedAt.getTime()
        };
      });

      const courseProgressMap: Record<string, any> = {};
      courseProgress.forEach(c => {
        courseProgressMap[c.courseSlug] = {
          lessonSlug: c.lastLessonSlug,
          url: c.lastLessonUrl,
          title: c.lastLessonTitle,
          index: c.lastLessonIndex,
          ts: c.accessedAt.getTime()
        };
      });

      const todosByLesson: Record<string, Record<string, boolean>> = {};
      todos.forEach(t => {
        if (!todosByLesson[t.lessonSlug]) {
          todosByLesson[t.lessonSlug] = {};
        }
        todosByLesson[t.lessonSlug][t.todoId] = t.isCompleted;
      });

      res.json({
        success: true,
        data: {
          progressByLesson,
          courseProgress: courseProgressMap,
          todos: todosByLesson,
          lastLesson: lastLesson ? {
            lessonSlug: lastLesson.lessonSlug,
            courseSlug: lastLesson.courseSlug,
            url: lastLesson.url,
            title: lastLesson.title,
            headline: lastLesson.headline,
            index: lastLesson.lessonIndex,
            ts: lastLesson.accessedAt.getTime()
          } : null
        }
      });
    } catch (error) {
      console.error('Sync error:', error);
      res.status(500).json({ error: 'Failed to sync data' });
    }
  }
};
