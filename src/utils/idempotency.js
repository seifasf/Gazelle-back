import WebhookReceipt from '../models/WebhookReceipt.js';
import Settings from '../models/Settings.js';
import { getAgenda } from '../config/agenda.js';
import { JOB_NAMES } from '../constants/index.js';
import logger from '../utils/logger.js';

export async function enqueueShopifyWebhook({ topic, externalId, payload }) {
  try {
    const receipt = await WebhookReceipt.create({
      source: 'shopify',
      externalId,
      topic,
      payload,
    });

    await Settings.findOneAndUpdate(
      { key: 'global' },
      { shopifyLastWebhookAt: new Date() },
      { upsert: true }
    );

    const agenda = getAgenda();
    await agenda.now(JOB_NAMES.PROCESS_SHOPIFY_WEBHOOK, {
      receiptId: receipt._id.toString(),
      topic,
    });

    return receipt;
  } catch (error) {
    if (error.code === 11000) {
      logger.info({ externalId, topic }, 'Duplicate Shopify webhook ignored');
      return null;
    }
    throw error;
  }
}

export async function enqueueBostaWebhook({ externalId, payload }) {
  try {
    const receipt = await WebhookReceipt.create({
      source: 'bosta',
      externalId,
      payload,
    });

    await Settings.findOneAndUpdate(
      { key: 'global' },
      { bostaLastWebhookAt: new Date() },
      { upsert: true }
    );

    const agenda = getAgenda();
    await agenda.now(JOB_NAMES.PROCESS_BOSTA_WEBHOOK, {
      receiptId: receipt._id.toString(),
    });

    return receipt;
  } catch (error) {
    if (error.code === 11000) {
      logger.info({ externalId }, 'Duplicate Bosta webhook ignored');
      return null;
    }
    throw error;
  }
}

export default { enqueueShopifyWebhook, enqueueBostaWebhook };
