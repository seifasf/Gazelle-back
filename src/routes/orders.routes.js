import { Router } from 'express';
import * as ordersController from '../controllers/orders.controller.js';
import { authenticate } from '../middleware/auth.js';
import { requireRoles, sanitizeFinancialResponse } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate, sanitizeFinancialResponse);

router.get('/counts', requireRoles('admin', 'orders_manager', 'stock_manager'), ordersController.getStateCounts);
router.post('/manual', requireRoles('admin', 'orders_manager'), ordersController.createManualOrder);
router.get('/', requireRoles('admin', 'orders_manager', 'stock_manager'), ordersController.listOrders);
router.get('/:id', requireRoles('admin', 'orders_manager', 'stock_manager'), ordersController.getOrder);
router.get(
  '/:id/history',
  requireRoles('admin', 'orders_manager', 'stock_manager'),
  ordersController.getStatusHistory
);
router.post('/:id/claim', requireRoles('admin', 'orders_manager', 'stock_manager'), ordersController.claimOrder);
router.post('/:id/verify', requireRoles('admin', 'orders_manager'), ordersController.verifyOrder);
router.post('/:id/delay', requireRoles('admin', 'orders_manager'), ordersController.delayOrder);
router.post('/:id/cancel', requireRoles('admin', 'orders_manager'), ordersController.cancelOrder);
router.post('/:id/exchange', requireRoles('admin', 'orders_manager'), ordersController.exchangeItem);
router.patch('/:id/shipping', requireRoles('admin', 'orders_manager'), ordersController.updateShippingAddress);
router.post('/:id/transition', requireRoles('admin', 'orders_manager'), ordersController.transitionStatus);
router.post(
  '/:id/confirm-return',
  requireRoles('admin', 'stock_manager'),
  ordersController.confirmReturn
);

export default router;
