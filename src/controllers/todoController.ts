import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { prisma } from '../config/database';

export const todoController = {
  // Save todos for a lesson
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

  // Get todos for a lesson
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

  // Get all todos for a user
  async getAllTodos(req: AuthRequest, res: Response) {
    try {
      const memberId = req.userId!;

      const todos = await prisma.lessonTodo.findMany({
        where: { memberId }
      });

      // Group by lesson
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
