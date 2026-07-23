import { Router } from 'express';
import * as fulfillmentController from '../controllers/fulfillment.controller.js';
import { authenticate } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate);

router.get('/warehouse-review', requireRoles('admin', 'stock_manager'), fulfillmentController.getWarehouseReview);
router.get('/warehouse-review/export', requireRoles('admin', 'stock_manager'), fulfillmentController.exportWarehouseReview);
router.get('/pick-list', requireRoles('admin', 'stock_manager'), fulfillmentController.getPickList);
router.post('/:id/pick-pack', requireRoles('admin', 'stock_manager'), fulfillmentController.pickAndPack);
router.post('/:id/prepare-awb', requireRoles('admin', 'stock_manager'), fulfillmentController.prepareAwb);
// Read-only shipment status for orders managers (order detail integrations panel).
router.get(
  '/:id/shipment-status',
  requireRoles('admin', 'stock_manager', 'orders_manager'),
  fulfillmentController.getShipmentStatus
);
router.get('/:id/stock-check', requireRoles('admin', 'stock_manager'), fulfillmentController.checkStock);
router.get('/:id/awb', requireRoles('admin', 'stock_manager'), fulfillmentController.getAwb);
router.get('/:id/order-sheet', requireRoles('admin', 'stock_manager'), fulfillmentController.getOrderSheet);

export default router;
