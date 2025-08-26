import { Router } from 'express';
import progressRoutes from './progress';
import todoRoutes from './todos';
import syncRoutes from './sync';
import activityRoutes from './activity';

const router = Router();

router.use('/progress', progressRoutes);
router.use('/todos', todoRoutes);
router.use('/sync', syncRoutes);
router.use('/activity', activityRoutes);

export default router;
