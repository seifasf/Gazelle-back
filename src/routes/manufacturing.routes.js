import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';
import manufacturingController from '../controllers/manufacturing.controller.js';

const router = Router();

router.use(authenticate, adminOnly);

router.get('/factories', manufacturingController.listFactories);
router.post('/factories', manufacturingController.createFactory);
router.patch('/factories/:id', manufacturingController.updateFactory);
router.delete('/factories/:id', manufacturingController.deleteFactory);

router.get('/purchase-orders', manufacturingController.listPurchaseOrders);
router.post('/purchase-orders', manufacturingController.createPurchaseOrder);
router.get('/purchase-orders/:id', manufacturingController.getPurchaseOrder);
router.patch('/purchase-orders/:id', manufacturingController.updatePurchaseOrder);
router.post('/purchase-orders/:id/receive', manufacturingController.receivePurchaseOrder);
router.get('/purchase-orders/:id/export', manufacturingController.exportPurchaseOrder);

export default router;
