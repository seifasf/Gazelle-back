import { processShopifyWebhookJob } from '../webhooks/shopify.handlers.js';
import { processBostaStatusUpdate, pollStuckOrders } from '../integrations/bosta/tracking.service.js';
import { syncBostaReturns } from '../integrations/bosta/returns.service.js';
import { syncOrderStatesFromBosta } from '../integrations/bosta/orderStates.service.js';
import { syncCatalog } from '../integrations/shopify/sync.service.js';
import { importShopifyOrdersSince } from '../integrations/shopify/setup.service.js';
import InventoryLedger from '../models/InventoryLedger.js';
import Variant from '../models/Variant.js';
import Order from '../models/Order.js';
import Settings from '../models/Settings.js';
import WebhookReceipt from '../models/WebhookReceipt.js';
import { inventoryAdjustQuantities } from '../integrations/shopify/mutations/inventoryAdjust.js';
import { assertShopifyInventoryWriteAllowed } from '../integrations/shopify/writePolicy.js';
import { config } from '../config/index.js';
import { JOB_NAMES } from '../constants/index.js';
import { checkRestockNeeded, checkSlowMovers } from '../services/adminJobs.service.js';
import logger from '../utils/logger.js';

export function registerJobs(agenda) {
  agenda.define(JOB_NAMES.PROCESS_SHOPIFY_WEBHOOK, async (job) => {
    const { receiptId, topic } = job.attrs.data;
    await processShopifyWebhookJob({ receiptId, topic });
  });

  agenda.define(JOB_NAMES.PROCESS_BOSTA_WEBHOOK, async (job) => {
    const { receiptId } = job.attrs.data;
    const receipt = await WebhookReceipt.findById(receiptId);
    if (!receipt || receipt.processedAt) return;

    const { normalizeBostaWebhookPayload } = await import('../integrations/bosta/webhookPayload.js');
    const { payload, deliveryId, state } = normalizeBostaWebhookPayload(receipt.payload);

    try {
      const updated = await processBostaStatusUpdate({
        deliveryId,
        state,
        payload,
        note: 'Bosta webhook',
      });
      receipt.processedAt = new Date();
      if (!updated) {
        receipt.error = 'no_matching_order';
      } else if (receipt.error) {
        receipt.error = undefined;
      }
      await receipt.save();
    } catch (error) {
      receipt.error = error.message;
      await receipt.save();
      throw error;
    }
  });

  agenda.define(JOB_NAMES.SHOPIFY_OUTBOUND_INVENTORY, async (job) => {
    const { ledgerId } = job.attrs.data;
    const ledger = await InventoryLedger.findById(ledgerId);
    if (!ledger || ledger.shopifySyncStatus === 'synced') return;

    const variant = await Variant.findById(ledger.variantId);
    if (!variant) throw new Error('Variant not found for ledger sync');

    const settings = await Settings.findOne({ key: 'global' });
    const locationId = settings?.shopifyLocationId || config.SHOPIFY_LOCATION_ID;
    if (!locationId) throw new Error('Shopify location ID not configured');

    await assertShopifyInventoryWriteAllowed();

    try {
      await inventoryAdjustQuantities({
        inventoryItemId: variant.shopifyInventoryItemId,
        locationId,
        delta: ledger.quantityDelta,
        idempotencyKey: ledger._id.toString(),
      });

      ledger.shopifySyncStatus = 'synced';
      variant.onlineStock += ledger.quantityDelta;
      await variant.save();
      await ledger.save();
    } catch (error) {
      ledger.shopifySyncStatus = 'failed';
      ledger.shopifySyncError = error.message;
      await ledger.save();
      throw error;
    }
  });

  agenda.define(JOB_NAMES.SHOPIFY_CATALOG_SYNC, async () => {
    await syncCatalog();
  });

  agenda.define(JOB_NAMES.BOSTA_CREATE_SHIPMENT, async (job) => {
    const { orderId, actorUserId } = job.attrs.data;
    const fulfillmentService = await import('../services/fulfillment.service.js');
    return fulfillmentService.createBostaShipmentForOrder(orderId, actorUserId);
  });

  agenda.define(JOB_NAMES.BOSTA_POLLING_FALLBACK, async () => {
    const settings = await Settings.findOne({ key: 'global' });
    // Default 2h — webhooks often miss when APP_URL is wrong; poll keeps states live.
    const hours = settings?.bostaPollingThresholdHours || 2;
    return pollStuckOrders(hours);
  });

  agenda.define(JOB_NAMES.BOSTA_ORDER_STATES_SYNC, async () => {
    const result = await syncOrderStatesFromBosta({ limit: 100 });
    logger.info(result, 'Scheduled Bosta order-states sync finished');
    return result;
  });

  agenda.define(JOB_NAMES.BOSTA_RETURNS_SYNC, async () => {
    const result = await syncBostaReturns({ maxPages: 60 });
    logger.info(result, 'Scheduled Bosta returns sync finished');
    return result;
  });

  agenda.define(JOB_NAMES.CHECK_RESTOCK_NEEDED, async () => checkRestockNeeded());
  agenda.define(JOB_NAMES.CHECK_SLOW_MOVERS, async () => checkSlowMovers());

  agenda.define(JOB_NAMES.SHOPIFY_ORDERS_SYNC, async () => {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const result = await importShopifyOrdersSince({ since, maxItems: 250 });
    logger.info(result, 'Scheduled Shopify orders sync finished');
    return result;
  });

  agenda.define(JOB_NAMES.ORDER_DELAY_CALLBACKS, async () => {
    const orderService = await import('../services/order.service.js');
    const result = await orderService.processDelayCallbacksDue();
    logger.info(result, 'Order delay callbacks processed');
    return result;
  });

  logger.info('Agenda jobs registered');
}

export async function scheduleRecurringJobs(agenda) {
  await agenda.every('1 hour', JOB_NAMES.SHOPIFY_CATALOG_SYNC);
  await agenda.every('5 minutes', JOB_NAMES.SHOPIFY_ORDERS_SYNC);
  await agenda.every('10 minutes', JOB_NAMES.BOSTA_ORDER_STATES_SYNC);
  await agenda.every('30 minutes', JOB_NAMES.BOSTA_POLLING_FALLBACK);
  await agenda.every('30 minutes', JOB_NAMES.BOSTA_RETURNS_SYNC);
  await agenda.every('24 hours', JOB_NAMES.CHECK_RESTOCK_NEEDED);
  await agenda.every('24 hours', JOB_NAMES.CHECK_SLOW_MOVERS);
  // ~08:00 Cairo daily (cron uses server local; also safe to run every day morning window)
  await agenda.every('0 5 * * *', JOB_NAMES.ORDER_DELAY_CALLBACKS);
  logger.info('Agenda recurring jobs scheduled');
}

export default { registerJobs };
