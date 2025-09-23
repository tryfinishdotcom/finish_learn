import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { prisma } from '../config/database';

export const todoController = {
  // Save todos for a lesson (legacy support)
  async saveTodos(req: AuthRequest, res: Response) {
    try {
      const memberId = req.userId!;
      const { lessonSlug } = req.params;
      const { todos } = req.body; // { [todoId]: boolean }

      const operations = Object.entries(todos).map(([todoId, isCompleted]) =>
        prisma.lessonTodo.upsert({
          where: {
            memberId_lessonSlug_todoId: { memberId, lessonSlug, todoId }
          },
          update: {
            isCompleted: isCompleted as boolean,
            completedAt: isCompleted ? new Date() : null
          },
          create: {
            memberId,
            lessonSlug,
            todoId,
            isCompleted: isCompleted as boolean,
            completedAt: isCompleted ? new Date() : null
          }
        })
      );

      await prisma.$transaction(operations);
      res.json({ success: true });
    } catch (error) {
      console.error('Save todos error:', error);
      res.status(500).json({ error: 'Failed to save todos' });
    }
  },

  // Get todos for a lesson (legacy support)
  async getTodos(req: AuthRequest, res: Response) {
    try {
      const memberId = req.userId!;
      const { lessonSlug } = req.params;

      const todos = await prisma.lessonTodo.findMany({
        where: { memberId, lessonSlug }
      });

      // Transform to match frontend format
      const todoState: Record<string, boolean> = {};
      todos.forEach(todo => {
        todoState[todo.todoId] = todo.isCompleted;
      });

      res.json({ success: true, data: todoState });
    } catch (error) {
      console.error('Get todos error:', error);
      res.status(500).json({ error: 'Failed to get todos' });
    }
  },

  // Save todos for an entire course (new course-based structure)
  async saveCourseTodos(req: AuthRequest, res: Response) {
    try {
      const memberId = req.userId!;
      const { courseSlug } = req.params;
      const { todos } = req.body; // { [lessonSlug]: { [todoId]: boolean } }

      // Validate input
      if (!todos || typeof todos !== 'object') {
        return res.status(400).json({ error: 'Invalid todos format' });
      }

      const operations = [];
      
      // Iterate through all lessons in the course
      for (const [lessonSlug, lessonTodos] of Object.entries(todos)) {
        if (!lessonTodos || typeof lessonTodos !== 'object') continue;
        
        for (const [todoId, isCompleted] of Object.entries(lessonTodos as Record<string, boolean>)) {
          operations.push(
            prisma.lessonTodo.upsert({
              where: {
                memberId_lessonSlug_todoId: { memberId, lessonSlug, todoId }
              },
              update: {
                isCompleted: Boolean(isCompleted),
                completedAt: isCompleted ? new Date() : null
              },
              create: {
                memberId,
                lessonSlug,
                todoId,
                isCompleted: Boolean(isCompleted),
                completedAt: isCompleted ? new Date() : null
              }
            })
          );
        }
      }

      if (operations.length > 0) {
        await prisma.$transaction(operations);
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error('Save course todos error:', error);
      res.status(500).json({ error: 'Failed to save course todos' });
    }
  },

  // Get todos for an entire course (new course-based structure)
  async getCourseTodos(req: AuthRequest, res: Response) {
    try {
      const memberId = req.userId!;
      const { courseSlug } = req.params;
      
      // Get all lesson progress for this course to know which lessons belong to it
      const lessonProgress = await prisma.lessonProgress.findMany({
        where: { 
          memberId,
          courseSlug 
        },
        select: {
          lessonSlug: true
        }
      });
      
      const lessonSlugs = lessonProgress.map(lp => lp.lessonSlug);
      
      if (lessonSlugs.length === 0) {
        // No lessons found for this course, return empty object
        return res.json({ success: true, data: {} });
      }
      
      // Get todos for all lessons in this course
      const todos = await prisma.lessonTodo.findMany({
        where: { 
          memberId,
          lessonSlug: { in: lessonSlugs }
        }
      });

      // Transform to match frontend format: { [lessonSlug]: { [todoId]: boolean } }
      const courseState: Record<string, Record<string, boolean>> = {};
      
      todos.forEach(todo => {
        if (!courseState[todo.lessonSlug]) {
          courseState[todo.lessonSlug] = {};
        }
        courseState[todo.lessonSlug][todo.todoId] = todo.isCompleted;
      });

      res.json({ success: true, data: courseState });
    } catch (error) {
      console.error('Get course todos error:', error);
      res.status(500).json({ error: 'Failed to get course todos' });
    }
  },

  // Get all todos for a user
  async getAllTodos(req: AuthRequest, res: Response) {
    try {
      const memberId = req.userId!;

      const todos = await prisma.lessonTodo.findMany({
        where: { memberId }
      });

      // Group by lesson (legacy format for backward compatibility)
      const todosByLesson: Record<string, Record<string, boolean>> = {};
      todos.forEach(todo => {
        if (!todosByLesson[todo.lessonSlug]) {
          todosByLesson[todo.lessonSlug] = {};
        }
        todosByLesson[todo.lessonSlug][todo.todoId] = todo.isCompleted;
      });

      res.json({ success: true, data: todosByLesson });
    } catch (error) {
      console.error('Get all todos error:', error);
      res.status(500).json({ error: 'Failed to get todos' });
    }
  }
};
