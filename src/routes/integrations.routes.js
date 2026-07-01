import { Router } from 'express';
import * as integrationsController from '../controllers/integrations.controller.js';
import { authenticate } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate, adminOnly);
router.get('/health', integrationsController.getHealth);

export default router;
