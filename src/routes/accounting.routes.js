import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';
import accountingController from '../controllers/accounting.controller.js';

const router = Router();

router.use(authenticate, adminOnly);

router.get('/accounts', accountingController.listAccounts);
router.post('/accounts', accountingController.createAccount);
router.patch('/accounts/:id', accountingController.updateAccount);

router.get('/journal', accountingController.listJournal);
router.post('/journal', accountingController.createJournal);

router.get('/reports/pl', accountingController.profitAndLoss);
router.get('/reports/balance-sheet', accountingController.balanceSheet);
router.get('/reports/top-products', accountingController.topProducts);

export default router;
