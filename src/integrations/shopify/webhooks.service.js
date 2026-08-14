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

const LIST_WEBHOOKS = `
  query ListWebhooks {
    webhookSubscriptions(first: 50) {
      edges {
        node { id topic uri }
      }
    }
  }
`;

const REGISTER_MUTATION = `
  mutation RegisterWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }
`;

export async function listShopifyWebhooks() {
  const data = await shopifyGraphQL(LIST_WEBHOOKS);
  return (data?.webhookSubscriptions?.edges || []).map((e) => ({
    id: e.node?.id,
    topic: e.node?.topic,
    uri: e.node?.uri,
  }));
}

export async function registerShopifyWebhooks() {
  const baseUrl = (config.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
  const results = [];

  for (const topic of WEBHOOK_TOPICS) {
    const path = TOPIC_TO_PATH[topic];
    const callbackUrl = `${baseUrl}/webhooks/shopify/${path}`;

    try {
      const data = await shopifyGraphQL(REGISTER_MUTATION, {
        topic,
        webhookSubscription: { uri: callbackUrl, format: 'JSON' },
      });
      const errors = data?.webhookSubscriptionCreate?.userErrors || [];
      if (errors.length) {
        results.push({ topic, ok: false, callbackUrl, errors });
      } else {
        results.push({
          topic,
          ok: true,
          callbackUrl: data?.webhookSubscriptionCreate?.webhookSubscription?.uri || callbackUrl,
        });
      }
    } catch (error) {
      logger.warn({ topic, err: error }, 'Webhook registration failed');
      results.push({ topic, ok: false, callbackUrl, error: error.message });
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

export default { registerShopifyWebhooks, listShopifyWebhooks };
