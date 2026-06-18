import { Router } from 'express';
import * as settingsController from '../controllers/settings.controller.js';
import { authenticate } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate, adminOnly);

router.get('/', settingsController.getSettings);
router.patch('/', settingsController.updateSettings);
router.post('/bosta-mappings', settingsController.upsertBostaMapping);
router.post('/shopify/sync', settingsController.forceShopifySync);

export default router;
