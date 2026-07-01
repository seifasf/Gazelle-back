import { config } from '../../config/index.js';
import { shopifyGraphQL } from './client.js';
import Settings from '../../models/Settings.js';
import logger from '../../utils/logger.js';

const WEBHOOK_TOPICS = [
  'ORDERS_CREATE',
  'ORDERS_CANCELLED',
  'ORDERS_UPDATED',
  'PRODUCTS_UPDATE',
  'INVENTORY_LEVELS_UPDATE',
  'REFUNDS_CREATE',
];

const TOPIC_TO_PATH = {
  ORDERS_CREATE: 'orders-create',
  ORDERS_CANCELLED: 'orders-cancelled',
  ORDERS_UPDATED: 'orders-updated',
  PRODUCTS_UPDATE: 'products-update',
  INVENTORY_LEVELS_UPDATE: 'inventory_levels-update',
  REFUNDS_CREATE: 'refunds-create',
};

const REGISTER_MUTATION = `
  mutation RegisterWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
    ) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`;

export async function registerShopifyWebhooks() {
  const baseUrl = (config.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
  const results = [];

  for (const topic of WEBHOOK_TOPICS) {
    const path = TOPIC_TO_PATH[topic];
    const callbackUrl = `${baseUrl}/webhooks/shopify/${path}`;

    try {
      const data = await shopifyGraphQL(REGISTER_MUTATION, { topic, callbackUrl });
      const errors = data?.webhookSubscriptionCreate?.userErrors || [];
      if (errors.length) {
        results.push({ topic, ok: false, errors });
      } else {
        results.push({ topic, ok: true, callbackUrl });
      }
    } catch (error) {
      logger.warn({ topic, err: error }, 'Webhook registration failed');
      results.push({ topic, ok: false, error: error.message });
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  if (successCount > 0) {
    await Settings.findOneAndUpdate(
      { key: 'global' },
      { shopifyWebhooksRegisteredAt: new Date() },
      { upsert: true }
    );
  }

  return { results, successCount, total: WEBHOOK_TOPICS.length };
}

export default { registerShopifyWebhooks };
