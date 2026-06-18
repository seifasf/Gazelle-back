import { Router } from 'express';
import * as customersController from '../controllers/customers.controller.js';
import { authenticate } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate);

router.get('/', requireRoles('admin', 'orders_manager'), customersController.listCustomers);
router.get('/:id', requireRoles('admin', 'orders_manager'), customersController.getCustomer);
router.patch('/:id/risk-flag', requireRoles('admin', 'orders_manager'), customersController.updateRiskFlag);

export default router;
