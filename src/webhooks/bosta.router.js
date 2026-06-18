import { Router } from 'express';
import { enqueueBostaWebhook } from '../utils/idempotency.js';

const router = Router();

router.post('/', async (req, res) => {
  const payload = req.body;
  const deliveryId = payload._id || payload.deliveryId || payload.id;
  const externalId = `${deliveryId}-${payload.state || payload.status || Date.now()}`;

  await enqueueBostaWebhook({ externalId, payload });
  res.status(200).json({ received: true });
});

export default router;
