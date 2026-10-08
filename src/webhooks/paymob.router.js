import { Router } from 'express';
import WebhookReceipt from '../models/WebhookReceipt.js';
import {
  processPaymobReceipt,
  unwrapPaymobPayload,
} from '../integrations/paymob/webhookReceipt.service.js';
import { verifyPaymobHmac } from './verifyPaymobHmac.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const router = Router();

router.post('/', async (req, res) => {
  const raw = req.body;
  const payload = unwrapPaymobPayload(raw);
  const hmac = req.query?.hmac || req.get('hmac') || raw?.hmac;

  if (config.PAYMOB_HMAC_SECRET) {
    if (!verifyPaymobHmac(payload, hmac)) {
      logger.warn({ hasHmac: Boolean(hmac), keys: Object.keys(payload || {}) }, 'Paymob HMAC rejected');
      return res.status(401).json({ error: 'Invalid HMAC' });
    }
  } else if (config.ALLOW_UNSIGNED_WEBHOOKS) {
    logger.warn('PAYMOB_HMAC_SECRET not set - accepting unsigned webhook (ALLOW_UNSIGNED_WEBHOOKS=true)');
  } else {
    logger.error('PAYMOB_HMAC_SECRET not set - rejecting Paymob webhook');
    return res.status(401).json({ error: 'Webhook signing secret not configured' });
  }

  const status =
    payload?.success != null
      ? payload.success
      : payload?.status || payload?.transaction_status || payload?.payment_status;
  const paymentId = payload?.id || payload?.payment_request_id || payload?.payment_id;
  const externalId = `${paymentId || 'paymob'}-${status ?? 'event'}`;

  try {
    let receipt;
    try {
      receipt = await WebhookReceipt.create({ source: 'paymob', externalId, payload: raw });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      receipt = await WebhookReceipt.findOne({ source: 'paymob', externalId });
      if (!receipt || receipt.processedAt) {
        logger.info({ externalId }, 'Duplicate Paymob webhook ignored');
        return res.status(200).json({ received: true, duplicate: true });
      }
    }

    const result = await processPaymobReceipt(receipt);
    return res.status(200).json({ received: true, recorded: Boolean(result?.recorded) });
  } catch (error) {
    logger.error({ err: error?.message || error, externalId }, 'Paymob webhook failed');
    return res.status(500).json({ error: 'Paymob webhook failed' });
  }
});

export default router;
