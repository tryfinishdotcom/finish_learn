import { Router } from 'express';
import { syncController } from '../controllers/syncController';
import { authenticateUser } from '../middleware/auth';

const router = Router();

// All routes require authentication
router.use(authenticateUser);

router.get('/all', syncController.syncAll);

export default router;
