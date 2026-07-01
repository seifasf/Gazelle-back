import { Router } from 'express';
import { verifyShopifyHmac } from './verifyShopifyHmac.js';
import { enqueueShopifyWebhook } from '../utils/idempotency.js';

const router = Router();

router.post('/:topic', async (req, res) => {
  const topic = req.params.topic.replace(/-/g, '/');
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const rawBody = req.rawBody || JSON.stringify(req.body);

  if (!(await verifyShopifyHmac(rawBody, hmac))) {
    return res.status(401).json({ error: 'Invalid HMAC' });
  }

  const externalId =
    req.get('X-Shopify-Webhook-Id') ||
    req.get('X-Shopify-Event-Id') ||
    `${topic}-${req.body?.id || Date.now()}`;

  await enqueueShopifyWebhook({ topic, externalId, payload: req.body });
  res.status(200).send('OK');
});

export default router;
