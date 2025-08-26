import { Router } from 'express';
import { activityController } from '../controllers/activityController';
import { authenticateUser } from '../middleware/auth';

const router = Router();

// All routes require authentication
router.use(authenticateUser);

router.get('/recent', activityController.getRecentActivity);
router.get('/stats', activityController.getUserStats);

export default router;
