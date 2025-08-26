import { Router } from 'express';
import { todoController } from '../controllers/todoController';
import { authenticateUser } from '../middleware/auth';
import { todoValidation } from '../middleware/validation';

const router = Router();

// All routes require authentication
router.use(authenticateUser);

router.post('/lesson/:lessonSlug', todoValidation.saveTodos, todoController.saveTodos);
router.get('/lesson/:lessonSlug', todoValidation.getTodos, todoController.getTodos);
router.get('/all', todoController.getAllTodos);

export default router;
