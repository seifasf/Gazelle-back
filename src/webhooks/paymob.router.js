import { Router } from 'express';
import WebhookReceipt from '../models/WebhookReceipt.js';
import { recordPaymobPayment } from '../integrations/paymob/payments.service.js';
import logger from '../utils/logger.js';

const router = Router();

router.post('/', async (req, res) => {
  const payload = req.body;

  const status = payload?.status || payload?.transaction_status || payload?.payment_status || payload?.success;
  const paymentId = payload?.id || payload?.transaction?.id || payload?.payment_request_id || payload?.payment_id;
  const externalId = `${paymentId || 'paymob'}-${status || 'event'}`;

  try {
    const receipt = await WebhookReceipt.create({
      source: 'paymob',
      externalId,
      payload,
    });

    await recordPaymobPayment(payload);
    receipt.processedAt = new Date();
    await receipt.save();
  } catch (error) {
    if (error?.code === 11000) {
      logger.info({ externalId }, 'Duplicate Paymob webhook ignored');
      return res.status(200).json({ received: true, duplicate: true });
    }
    logger.error({ err: error?.message || error, externalId }, 'Paymob webhook failed');
    return res.status(500).json({ error: 'Paymob webhook failed' });
  }

  return res.status(200).json({ received: true });
});

export default router;
