import WebhookReceipt from '../models/WebhookReceipt.js';
import Settings from '../models/Settings.js';
import { getAgenda } from '../config/agenda.js';
import { JOB_NAMES } from '../constants/index.js';
import logger from '../utils/logger.js';

const JOB_BY_SOURCE = {
  shopify: JOB_NAMES.PROCESS_SHOPIFY_WEBHOOK,
  bosta: JOB_NAMES.PROCESS_BOSTA_WEBHOOK,
};

export async function enqueueReceiptJob(receipt) {
  const jobName = JOB_BY_SOURCE[receipt.source];
  if (!jobName) return;
  await getAgenda().now(jobName, {
    receiptId: receipt._id.toString(),
    ...(receipt.topic ? { topic: receipt.topic } : {}),
  });
}

async function touchLastWebhookAt(field) {
  try {
    await Settings.findOneAndUpdate({ key: 'global' }, { [field]: new Date() }, { upsert: true });
  } catch (err) {
    logger.warn({ err: err?.message || err, field }, 'Could not stamp last webhook time');
  }
}

/**
 * Store the receipt, then queue its job. A provider retry of an event whose first attempt
 * never finished (receipt saved, job not queued or failed) is queued again instead of dropped.
 */
async function enqueueWebhook({ source, topic, externalId, payload, settingsField }) {
  let receipt;
  try {
    receipt = await WebhookReceipt.create({ source, externalId, topic, payload });
  } catch (error) {
    if (error.code !== 11000) throw error;
    receipt = await WebhookReceipt.findOne({ source, externalId });
    if (!receipt || receipt.processedAt) {
      logger.info({ source, externalId, topic }, 'Duplicate webhook ignored');
      return null;
    }
    logger.info({ source, externalId, topic }, 'Webhook re-delivered before it was processed; queueing again');
  }

  await enqueueReceiptJob(receipt);
  await touchLastWebhookAt(settingsField);
  return receipt;
}

export function enqueueShopifyWebhook({ topic, externalId, payload }) {
  return enqueueWebhook({
    source: 'shopify',
    topic,
    externalId,
    payload,
    settingsField: 'shopifyLastWebhookAt',
  });
}

export function enqueueBostaWebhook({ externalId, payload }) {
  return enqueueWebhook({
    source: 'bosta',
    externalId,
    payload,
    settingsField: 'bostaLastWebhookAt',
  });
}

export default { enqueueShopifyWebhook, enqueueBostaWebhook, enqueueReceiptJob };
