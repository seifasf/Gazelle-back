import { Router } from 'express';
import * as shopifyController from '../controllers/shopify.controller.js';
import { authenticate } from '../middleware/auth.js';
import { adminOnly, requireRoles } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate);

// Connection + configuration: admin only.
router.get('/status', adminOnly, shopifyController.getStatus);
router.post('/connect', adminOnly, shopifyController.connect);
router.post('/test', adminOnly, shopifyController.testConnection);
router.post('/sync', adminOnly, shopifyController.syncCatalog);
router.get('/sync-status', adminOnly, shopifyController.syncStatus);
router.post('/register-webhooks', adminOnly, shopifyController.registerWebhooks);
router.get('/locations', adminOnly, shopifyController.getLocations);

// Data imports: admin + orders manager can pull orders/customers.
router.post('/import-orders', requireRoles('admin', 'orders_manager'), shopifyController.importOrders);
router.post('/import-customers', requireRoles('admin', 'orders_manager'), shopifyController.importCustomers);

export default router;
