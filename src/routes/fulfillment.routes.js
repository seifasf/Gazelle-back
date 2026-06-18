import { Router } from 'express';
import * as fulfillmentController from '../controllers/fulfillment.controller.js';
import { authenticate } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate);

router.get('/pick-list', requireRoles('admin', 'stock_manager'), fulfillmentController.getPickList);
router.post('/:id/pick-pack', requireRoles('admin', 'stock_manager'), fulfillmentController.pickAndPack);
router.get('/:id/awb', requireRoles('admin', 'stock_manager'), fulfillmentController.getAwb);

export default router;
