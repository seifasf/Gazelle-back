import { Router } from 'express';
import * as usersController from '../controllers/users.controller.js';
import { authenticate } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';

const router = Router();

router.use(authenticate, adminOnly);

router.get('/', usersController.listUsers);
router.post('/', usersController.createUser);
router.delete('/:id', usersController.deactivateUser);

export default router;
