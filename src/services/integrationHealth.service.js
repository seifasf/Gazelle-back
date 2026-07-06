import Settings from '../models/Settings.js';
import WebhookReceipt from '../models/WebhookReceipt.js';
import Order from '../models/Order.js';
import { getShopifyStatus } from '../integrations/shopify/setup.service.js';
import { isBostaConfigured } from '../integrations/bosta/client.js';

export async function getIntegrationHealth() {
  const settings = await Settings.findOne({ key: 'global' });
  const shopify = await getShopifyStatus();

  const [shopifyWebhookLast, bostaWebhookLast, failedShipments, pendingVerify, readyToShip, inTransit] =
    await Promise.all([
      WebhookReceipt.findOne({ source: 'shopify' }).sort({ createdAt: -1 }).select('createdAt topic'),
      WebhookReceipt.findOne({ source: 'bosta' }).sort({ createdAt: -1 }).select('createdAt'),
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
      pollingThresholdHours: settings?.bostaPollingThresholdHours ?? 48,
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
