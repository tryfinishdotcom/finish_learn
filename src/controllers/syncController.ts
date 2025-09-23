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

      // Transform lesson progress to frontend format
      const progressByLesson: Record<string, any> = {};
      const lessonToCourseMap = new Map<string, string>();
      
      lessonProgress.forEach(p => {
        progressByLesson[p.lessonSlug] = {
          sec: p.secondsWatched,
          dur: p.totalDuration,
          percent: p.percentComplete,
          courseSlug: p.courseSlug,
          ts: p.updatedAt.getTime()
        };
        lessonToCourseMap.set(p.lessonSlug, p.courseSlug);
      });

      // Transform course progress to frontend format
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

      // Transform todos to new course-based structure
      const todosByCourse: Record<string, Record<string, Record<string, boolean>>> = {};
      
      todos.forEach(t => {
        const courseSlug = lessonToCourseMap.get(t.lessonSlug);
        
        if (courseSlug) {
          // Initialize course object if doesn't exist
          if (!todosByCourse[courseSlug]) {
            todosByCourse[courseSlug] = {};
          }
          // Initialize lesson object if doesn't exist
          if (!todosByCourse[courseSlug][t.lessonSlug]) {
            todosByCourse[courseSlug][t.lessonSlug] = {};
          }
          // Set todo state
          todosByCourse[courseSlug][t.lessonSlug][t.todoId] = t.isCompleted;
        }
      });

      // Prepare response
      const response: any = {
        success: true,
        data: {
          progressByLesson,
          courseProgress: courseProgressMap,
          todosByCourse, // New course-based structure
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
      };

      // Include legacy todos format for backward compatibility
      const todosByLesson: Record<string, Record<string, boolean>> = {};
      todos.forEach(t => {
        if (!todosByLesson[t.lessonSlug]) {
          todosByLesson[t.lessonSlug] = {};
        }
        todosByLesson[t.lessonSlug][t.todoId] = t.isCompleted;
      });
      response.data.todos = todosByLesson;

      res.json(response);
    } catch (error) {
      console.error('Sync error:', error);
      res.status(500).json({ error: 'Failed to sync data' });
    }
  }
};
