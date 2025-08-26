import { Router } from 'express';
import { progressController } from '../controllers/progressController';
import { authenticateUser } from '../middleware/auth';
import { progressValidation } from '../middleware/validation';

const router = Router();

// All routes require authentication
router.use(authenticateUser);

router.post('/lesson', progressValidation.saveLessonProgress, progressController.saveLessonProgress);
router.get('/lessons', progressController.getAllLessonsProgress);
router.get('/course/:courseSlug', progressValidation.getCourseProgress, progressController.getCourseProgress);

export default router;
