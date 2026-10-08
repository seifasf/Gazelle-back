import { Router } from 'express';
import { enqueueBostaWebhook } from '../utils/idempotency.js';
import {
  normalizeBostaWebhookPayload,
  bostaWebhookExternalId,
} from '../integrations/bosta/webhookPayload.js';
import logger from '../utils/logger.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { payload, deliveryId, state, trackingNumber } = normalizeBostaWebhookPayload(req.body);
    const externalId = bostaWebhookExternalId({ deliveryId, state, trackingNumber });

    logger.info(
      { deliveryId, trackingNumber, state: typeof state === 'object' ? state.code ?? state.value : state },
      'Bosta webhook received'
    );

    await enqueueBostaWebhook({ externalId, payload });
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error({ err }, 'Bosta webhook enqueue failed');
    // Ask Bosta to retry: a re-delivered event whose receipt exists is queued again, not dropped.
    res.status(500).json({ received: false, error: 'enqueue_failed' });
  }
});

export default router;
