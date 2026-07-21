import Settings from '../models/Settings.js';
import WebhookReceipt from '../models/WebhookReceipt.js';
import Order from '../models/Order.js';
import { getShopifyStatus } from '../integrations/shopify/setup.service.js';
import { isBostaConfigured } from '../integrations/bosta/client.js';
import { bostaWebhookUrl } from '../integrations/bosta/webhookPayload.js';
import { config } from '../config/index.js';

export async function getIntegrationHealth() {
  const settings = await Settings.findOne({ key: 'global' });
  const shopify = await getShopifyStatus();

  const [
    shopifyWebhookLast,
    bostaWebhookLast,
    bostaWebhookFailed,
    paymobWebhookLast,
    failedShipments,
    pendingVerify,
    readyToShip,
    inTransit,
  ] = await Promise.all([
    WebhookReceipt.findOne({ source: 'shopify' }).sort({ createdAt: -1 }).select('createdAt topic'),
    WebhookReceipt.findOne({ source: 'bosta' }).sort({ createdAt: -1 }).select('createdAt processedAt error'),
    WebhookReceipt.countDocuments({ source: 'bosta', error: { $exists: true, $ne: null } }),
    WebhookReceipt.findOne({ source: 'paymob' }).sort({ createdAt: -1 }).select('createdAt'),
    Order.countDocuments({ bostaShipmentStatus: 'failed' }),
    Order.countDocuments({ internalStatus: 'pending_verification' }),
    Order.countDocuments({ internalStatus: 'verified_ready_for_shipping' }),
    Order.countDocuments({ internalStatus: { $in: ['picked_up_by_bosta', 'in_transit'] } }),
  ]);

  return {
    shopify: {
      ...shopify,
      writePolicy: settings?.shopifyWritePolicy || 'oms_only',
      lastWebhookAt: shopifyWebhookLast?.createdAt || settings?.shopifyLastWebhookAt,
      lastWebhookTopic: shopifyWebhookLast?.topic,
    },
    bosta: {
      configured: isBostaConfigured(),
      healthy: settings?.bostaConnectionHealthy ?? false,
      citiesCount: settings?.bostaCities?.length ?? 0,
      lastSyncAt: settings?.bostaLastSyncAt,
      lastWebhookAt: bostaWebhookLast?.createdAt || settings?.bostaLastWebhookAt,
      lastWebhookProcessedAt: bostaWebhookLast?.processedAt || null,
      lastWebhookError: bostaWebhookLast?.error || null,
      webhookFailures: bostaWebhookFailed,
      webhookUrl: bostaWebhookUrl(config.APP_URL),
      pollingThresholdHours: settings?.bostaPollingThresholdHours ?? 2,
    },
    paymob: {
      configured: Boolean(config.PAYMOB_HMAC_SECRET || config.PAYMOB_API_KEY),
      apiConfigured: Boolean(config.PAYMOB_API_KEY),
      hmacConfigured: Boolean(config.PAYMOB_HMAC_SECRET),
      healthy: Boolean(paymobWebhookLast?.createdAt),
      lastWebhookAt: paymobWebhookLast?.createdAt || null,
      webhookUrl: `${String(config.APP_URL || '').replace(/\/$/, '')}/webhooks/paymob`,
    },
    queues: {
      pendingVerification: pendingVerify,
      readyToShip,
      inTransit,
      failedShipments,
    },
  };
}

export default { getIntegrationHealth };
