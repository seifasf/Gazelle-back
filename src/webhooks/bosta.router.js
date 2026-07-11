import { Router } from 'express';
import { enqueueBostaWebhook } from '../utils/idempotency.js';

const router = Router();

router.post('/', async (req, res) => {
  const payload = req.body;
  const deliveryId = payload._id || payload.deliveryId || payload.id;
  const state = payload.state ?? payload.status;
  const stateKey =
    state && typeof state === 'object'
      ? state.code ?? state.value ?? state.name
      : state;
  const externalId = `${deliveryId}-${stateKey ?? Date.now()}`;

  await enqueueBostaWebhook({ externalId, payload });
  res.status(200).json({ received: true });
});

export default router;
