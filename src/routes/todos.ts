import { Router } from 'express';
import { todoController } from '../controllers/todoController';
import { authenticateUser } from '../middleware/auth';
import { todoValidation } from '../middleware/validation';

const router = Router();

// All routes require authentication
router.use(authenticateUser);

// Course-based endpoints (new structure)
router.put('/course/:courseSlug', todoController.saveCourseTodos);
router.get('/course/:courseSlug', todoController.getCourseTodos);

// Lesson-based endpoints (legacy support)
router.post('/lesson/:lessonSlug', todoValidation.saveTodos, todoController.saveTodos);
router.get('/lesson/:lessonSlug', todoValidation.getTodos, todoController.getTodos);

// Get all todos
router.get('/all', todoController.getAllTodos);

export default router;
