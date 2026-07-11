import { Router } from 'express';
import * as productsController from '../controllers/products.controller.js';
import { authenticate } from '../middleware/auth.js';
import { adminOnly, requireRoles, sanitizeFinancialResponse } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate, sanitizeFinancialResponse);

router.get('/', requireRoles('admin', 'stock_manager'), productsController.listProducts);
router.get('/cogs-health', adminOnly, productsController.cogsHealth);

router.patch('/variants/:variantId/cogs', adminOnly, productsController.updateCogs);
router.post('/variants/:variantId/cogs-batches', adminOnly, productsController.addCogsBatch);

export default router;
