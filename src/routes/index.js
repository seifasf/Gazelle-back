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

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
