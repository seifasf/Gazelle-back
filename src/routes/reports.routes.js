import { Router } from 'express';
import * as reportsController from '../controllers/reports.controller.js';
import { authenticate } from '../middleware/auth.js';
import { adminOnly, requireRoles } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate);

router.get(
  '/top-sellers',
  requireRoles('admin', 'orders_manager'),
  reportsController.topSellers
);

router.use(adminOnly);

router.get('/dashboard', reportsController.dashboard);
router.get('/profitability', reportsController.profitability);
router.get('/profitability/export', reportsController.exportProfitability);
router.get('/audit', reportsController.auditLog);
router.get('/audit/export', reportsController.exportAuditLog);

export default router;
