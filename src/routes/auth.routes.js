import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { loginAccountLimiter, loginIpLimiter } from '../middleware/loginRateLimit.js';

const router = Router();

router.post('/login', loginIpLimiter, loginAccountLimiter, authController.login);
router.get('/me', authenticate, authController.me);

export default router;
