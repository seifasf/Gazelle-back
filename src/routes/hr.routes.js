import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';
import hrController from '../controllers/hr.controller.js';

const router = Router();

router.use(authenticate, adminOnly);

router.get('/employees', hrController.listEmployees);
router.post('/employees', hrController.createEmployee);
router.get('/employees/:id', hrController.getEmployee);
router.patch('/employees/:id', hrController.updateEmployee);
router.get('/employees/:id/attendance', hrController.listAttendance);
router.post('/employees/:id/attendance', hrController.recordAttendance);
router.get('/employees/:id/kpis', hrController.getKpis);

router.get('/leave-requests', hrController.listLeaveRequests);
router.post('/leave-requests', hrController.createLeaveRequest);
router.patch('/leave-requests/:id', hrController.reviewLeaveRequest);

router.get('/payroll-summary', hrController.payrollSummary);

export default router;
