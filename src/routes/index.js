import { Router } from 'express';
import authRoutes from './auth.routes.js';
import ordersRoutes from './orders.routes.js';
import inventoryRoutes from './inventory.routes.js';
import customersRoutes from './customers.routes.js';
import productsRoutes from './products.routes.js';
import reportsRoutes from './reports.routes.js';
import usersRoutes from './users.routes.js';
import settingsRoutes from './settings.routes.js';
import fulfillmentRoutes from './fulfillment.routes.js';
import referenceRoutes from './reference.routes.js';
import shopifyRoutes from './shopify.routes.js';
import integrationsRoutes from './integrations.routes.js';
import notificationRoutes from './notification.routes.js';
import manufacturingRoutes from './manufacturing.routes.js';
import accountingRoutes from './accounting.routes.js';
import hrRoutes from './hr.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/orders', ordersRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/customers', customersRoutes);
router.use('/products', productsRoutes);
router.use('/reports', reportsRoutes);
router.use('/users', usersRoutes);
router.use('/settings', settingsRoutes);
router.use('/fulfillment', fulfillmentRoutes);
router.use('/reference', referenceRoutes);
router.use('/integrations/shopify', shopifyRoutes);
router.use('/integrations', integrationsRoutes);
router.use('/notifications', notificationRoutes);
router.use('/manufacturing', manufacturingRoutes);
router.use('/accounting', accountingRoutes);
router.use('/hr', hrRoutes);

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
