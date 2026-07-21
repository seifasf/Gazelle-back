import { Router } from 'express';
import WebhookReceipt from '../models/WebhookReceipt.js';
import { recordPaymobPayment } from '../integrations/paymob/payments.service.js';
import { verifyPaymobHmac } from './verifyPaymobHmac.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const router = Router();

/** Paymob sends the transaction under `obj` on processed callbacks. */
function unwrapPaymobPayload(body) {
  if (!body || typeof body !== 'object') return {};
  if (body.obj && typeof body.obj === 'object') return body.obj;
  if (body.transaction && typeof body.transaction === 'object') return body.transaction;
  return body;
}

router.post('/', async (req, res) => {
  const raw = req.body;
  const payload = unwrapPaymobPayload(raw);
  const hmac = req.query?.hmac || req.get('hmac') || raw?.hmac;

  if (config.PAYMOB_HMAC_SECRET) {
    if (!verifyPaymobHmac(payload, hmac)) {
      logger.warn({ hasHmac: Boolean(hmac), keys: Object.keys(payload || {}) }, 'Paymob HMAC rejected');
      return res.status(401).json({ error: 'Invalid HMAC' });
    }
  } else {
    logger.warn('PAYMOB_HMAC_SECRET not set — accepting webhook without verification');
  }

  const status =
    payload?.success != null
      ? payload.success
      : payload?.status || payload?.transaction_status || payload?.payment_status;
  const paymentId = payload?.id || payload?.payment_request_id || payload?.payment_id;
  const externalId = `${paymentId || 'paymob'}-${status ?? 'event'}`;

  try {
    const receipt = await WebhookReceipt.create({
      source: 'paymob',
      externalId,
      payload: raw,
    });

    const result = await recordPaymobPayment(payload);
    receipt.processedAt = new Date();
    if (result?.reason && result.reason !== 'duplicate') {
      receipt.error = result.reason;
    }
    await receipt.save();

    return res.status(200).json({ received: true, recorded: Boolean(result?.recorded) });
  } catch (error) {
    if (error?.code === 11000) {
      logger.info({ externalId }, 'Duplicate Paymob webhook ignored');
      return res.status(200).json({ received: true, duplicate: true });
    }
    logger.error({ err: error?.message || error, externalId }, 'Paymob webhook failed');
    return res.status(500).json({ error: 'Paymob webhook failed' });
  }
});

export default router;
