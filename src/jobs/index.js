import { processShopifyWebhookJob } from '../webhooks/shopify.handlers.js';
import { processBostaStatusUpdate } from '../integrations/bosta/tracking.service.js';
import { syncCatalog } from '../integrations/shopify/sync.service.js';
import { createDelivery } from '../integrations/bosta/shipments.service.js';
import { pollStuckOrders } from '../integrations/bosta/tracking.service.js';
import InventoryLedger from '../models/InventoryLedger.js';
import Variant from '../models/Variant.js';
import Order from '../models/Order.js';
import Customer from '../models/Customer.js';
import Settings from '../models/Settings.js';
import WebhookReceipt from '../models/WebhookReceipt.js';
import { inventoryAdjustQuantities } from '../integrations/shopify/mutations/inventoryAdjust.js';
import { assertShopifyInventoryWriteAllowed } from '../integrations/shopify/writePolicy.js';
import { config } from '../config/index.js';
import orderService from '../services/order.service.js';
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

    const payload = receipt.payload;
    const deliveryId = payload._id || payload.deliveryId || payload.id;
    const state = payload.state || payload.status;

    try {
      await processBostaStatusUpdate({ deliveryId, state, payload, note: 'Bosta webhook' });
      receipt.processedAt = new Date();
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
    const order = await Order.findById(orderId).populate('customerId');
    if (!order) throw new Error('Order not found');

    order.bostaShipmentStatus = 'creating';
    order.bostaShipmentError = null;
    await order.save();

    try {
      const result = await createDelivery(order, order.customerId);
      const deliveryId = result._id || result.id || result.data?._id;
      const trackingNumber = result.trackingNumber || result.tracking_number;

      order.bostaDeliveryId = deliveryId;
      order.bostaTrackingNumber = trackingNumber;
      order.bostaShipmentStatus = 'created';
      if (actorUserId) order.assignedStockManagerId = actorUserId;
      await order.save();

      await orderService.transitionOrderStatus(orderId, 'picked_up_by_bosta', {
        source: 'system',
        actorUserId,
        note: 'Bosta shipment created',
      });

      return result;
    } catch (error) {
      order.bostaShipmentStatus = 'failed';
      order.bostaShipmentError = error.message;
      await order.save();
      throw error;
    }
  });

  agenda.define(JOB_NAMES.BOSTA_POLLING_FALLBACK, async () => {
    const settings = await Settings.findOne({ key: 'global' });
    const hours = settings?.bostaPollingThresholdHours || 48;
    return pollStuckOrders(hours);
  });

  agenda.define(JOB_NAMES.CHECK_RESTOCK_NEEDED, async () => checkRestockNeeded());
  agenda.define(JOB_NAMES.CHECK_SLOW_MOVERS, async () => checkSlowMovers());

  logger.info('Agenda jobs registered');
}

export async function scheduleRecurringJobs(agenda) {
  await agenda.every('1 hour', JOB_NAMES.SHOPIFY_CATALOG_SYNC);
  await agenda.every('6 hours', JOB_NAMES.BOSTA_POLLING_FALLBACK);
  await agenda.every('24 hours', JOB_NAMES.CHECK_RESTOCK_NEEDED);
  await agenda.every('24 hours', JOB_NAMES.CHECK_SLOW_MOVERS);
  logger.info('Agenda recurring jobs scheduled');
}

export default { registerJobs };
