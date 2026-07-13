import { Router } from 'express';
import * as inventoryController from '../controllers/inventory.controller.js';
import { authenticate } from '../middleware/auth.js';
import { requireRoles, sanitizeFinancialResponse } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate, sanitizeFinancialResponse);

router.get('/catalog', requireRoles('admin', 'stock_manager'), inventoryController.listCatalog);
router.get('/catalog/filters', requireRoles('admin', 'stock_manager'), inventoryController.catalogFilters);
router.get('/variants/lookup', requireRoles('admin', 'stock_manager', 'orders_manager'), inventoryController.lookupVariantBySku);
router.post('/stock-intake', requireRoles('admin', 'stock_manager'), inventoryController.stockIntake);
// Orders managers need variant lists for exchanges during verification.
router.get('/variants', requireRoles('admin', 'stock_manager', 'orders_manager'), inventoryController.listVariants);
router.get('/variants/:id', requireRoles('admin', 'stock_manager', 'orders_manager'), inventoryController.getVariant);
router.get(
  '/variants/:id/barcode.png',
  requireRoles('admin', 'stock_manager'),
  inventoryController.getVariantBarcodePng
);
router.get(
  '/variants/:id/barcode-labels',
  requireRoles('admin', 'stock_manager'),
  inventoryController.getVariantBarcodeLabels
);
router.get('/variants/:id/ledger', requireRoles('admin', 'stock_manager'), inventoryController.getLedger);
router.post(
  '/variants/:id/adjust',
  requireRoles('admin', 'stock_manager'),
  inventoryController.adjustStock
);
router.get('/discrepancies', requireRoles('admin', 'stock_manager'), inventoryController.listDiscrepancies);
router.get('/queue-counts', requireRoles('admin', 'stock_manager'), inventoryController.getQueueCounts);

export default router;
