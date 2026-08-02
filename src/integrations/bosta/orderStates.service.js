import Order from '../../models/Order.js';
import '../../models/Customer.js';
import { bostaRequest, isBostaConfigured } from './client.js';
import { getDelivery } from './shipments.service.js';
import { processBostaStatusUpdate } from './tracking.service.js';
import logger from '../../utils/logger.js';

/** Foreign channels (old Woo store, etc.) must never auto-link onto Gazelle Shopify orders. */
function isForeignBostaDelivery(delivery) {
  const src = String(delivery?.creationSrc || delivery?.source || '').toUpperCase();
  if (src === 'WOOCOMMERCE' || src === 'WOO') return true;
  const ref = String(delivery?.businessReference || '').trim().toLowerCase();
  if (ref.startsWith('woocommerce') || ref.startsWith('woo_') || ref.startsWith('woo-')) return true;
  return false;
}

async function resolveLiveDelivery(order, fallbackDelivery) {
  const tracking =
    order.bostaTrackingNumber ||
    fallbackDelivery?.trackingNumber ||
    (fallbackDelivery?.trackingNumber != null ? String(fallbackDelivery.trackingNumber) : null);

  if (tracking) {
    try {
      return await getDelivery(String(tracking));
    } catch (err) {
      logger.warn({ err, tracking }, 'Bosta tracking lookup failed');
    }
  }

  if (order.bostaDeliveryId) {
    try {
      return await getDelivery(String(order.bostaDeliveryId));
    } catch (err) {
      logger.warn({ err, id: order.bostaDeliveryId }, 'Bosta id lookup failed');
    }
  }

  return fallbackDelivery || null;
}

async function linkAndSyncOrder(order, delivery, note) {
  if (isForeignBostaDelivery(delivery)) {
    logger.warn(
      { orderId: order._id, deliveryId: delivery?._id || delivery?.id },
      'Refusing to link foreign Bosta delivery'
    );
    return { orderId: order._id, linked: false, synced: false, reason: 'foreign' };
  }
  if (order.internalStatus === 'pending_verification' || order.internalStatus === 'no_response') {
    return { orderId: order._id, linked: false, synced: false, reason: order.internalStatus };
  }

  const deliveryId = String(delivery._id || delivery.id);
  const tracking =
    delivery.trackingNumber != null ? String(delivery.trackingNumber) : null;
  const ref = String(delivery.businessReference || '').trim();

  // Ready-to-ship must stay in the warehouse queue until Gazelle creates the
  // Bosta policy (businessReference = Mongo order id) or the order is already
  // linked to THIS delivery. Phone/COD guesses of old Woo deliveries used to
  // jump orders straight to delivered.
  if (
    order.internalStatus === 'verified_ready_for_shipping' ||
    order.internalStatus === 'awaiting_bosta_pickup'
  ) {
    const alreadyThis =
      order.bostaDeliveryId && String(order.bostaDeliveryId) === deliveryId;
    const gazelleOwned = ref && ref === String(order._id);
    if (!alreadyThis && !gazelleOwned) {
      logger.info(
        { orderId: order._id, deliveryId, ref, status: order.internalStatus },
        'Skipping Bosta link on ready/awaiting — not a Gazelle-created delivery'
      );
      return {
        orderId: order._id,
        linked: false,
        synced: false,
        reason: 'ready_requires_gazelle_delivery',
      };
    }
  }

  if (order.bostaDeliveryId && String(order.bostaDeliveryId) !== deliveryId) {
    logger.warn(
      { orderId: order._id, linked: order.bostaDeliveryId, candidate: deliveryId },
      'Refusing to link — order already has a different Bosta delivery'
    );
    return { orderId: order._id, linked: false, synced: false, reason: 'already_linked' };
  }
  if (
    order.bostaTrackingNumber &&
    tracking &&
    String(order.bostaTrackingNumber) !== tracking
  ) {
    logger.warn(
      {
        orderId: order._id,
        linkedTracking: order.bostaTrackingNumber,
        candidateTracking: tracking,
      },
      'Refusing to link — tracking mismatch'
    );
    return { orderId: order._id, linked: false, synced: false, reason: 'tracking_mismatch' };
  }

  const updates = {};
  if (!order.bostaDeliveryId) updates.bostaDeliveryId = deliveryId;
  if (tracking && !order.bostaTrackingNumber) updates.bostaTrackingNumber = tracking;
  if (order.bostaShipmentStatus === 'none' || !order.bostaShipmentStatus) {
    updates.bostaShipmentStatus = 'created';
  }
  if (Object.keys(updates).length) {
    Object.assign(order, updates);
    await order.save();
  }

  // Prefer the search payload (already has state/type/cod) — avoid extra getDelivery round-trips.
  const payload = delivery?.state ? delivery : await resolveLiveDelivery(order, delivery);
  const state = payload?.state || payload?.status || delivery.state;
  if (!state) return { orderId: order._id, linked: true, synced: false, reason: 'no_state' };

  await processBostaStatusUpdate({
    deliveryId: order.bostaDeliveryId || deliveryId,
    state,
    payload: payload || delivery,
    note,
  });

  return {
    orderId: order._id,
    deliveryId: order.bostaDeliveryId || deliveryId,
    tracking: order.bostaTrackingNumber || tracking,
    linked: true,
    synced: true,
    bostaState: typeof state === 'object' ? state.value || state.code : state,
  };
}

/**
 * Pull live Bosta states into OMS orders (already-linked shipments only).
 *
 * @param {{ limit?: number, since?: Date|string|null }} opts
 *   since — when set, only OMS orders placed on/after this date.
 */
export async function syncOrderStatesFromBosta({ limit = 80, since = null } = {}) {
  if (!isBostaConfigured()) {
    return { skipped: 'bosta_not_configured' };
  }

  const sinceDate = since ? new Date(since) : null;
  const sinceOk = sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : null;

  const results = {
    refreshed: 0,
    linked: 0,
    synced: 0,
    unmatched: 0,
    errors: [],
    samples: [],
    since: sinceOk ? sinceOk.toISOString() : null,
  };

  const linkedFilter = {
    $or: [
      { bostaDeliveryId: { $exists: true, $ne: null } },
      { bostaTrackingNumber: { $exists: true, $ne: null } },
    ],
    internalStatus: { $nin: ['cancelled', 'returned_to_stock'] },
  };
  if (sinceOk) linkedFilter.placedAt = { $gte: sinceOk };

  // 1) Refresh already-linked shipments via tracking number.
  const linkedOrders = await Order.find(linkedFilter)
    .sort({ lastStatusUpdateAt: 1, updatedAt: 1 })
    .limit(limit)
    .select('_id bostaDeliveryId bostaTrackingNumber bostaShipmentStatus internalStatus');

  for (const order of linkedOrders) {
    try {
      const payload = await resolveLiveDelivery(order, null);
      const state = payload?.state || payload?.status;
      if (!state) continue;
      await processBostaStatusUpdate({
        deliveryId: order.bostaDeliveryId || order.bostaTrackingNumber,
        state,
        payload,
        note: 'Bosta state sync (linked)',
      });
      results.refreshed += 1;
      results.synced += 1;
    } catch (err) {
      results.errors.push({ orderId: order._id, error: err.message });
      logger.warn({ err, orderId: order._id }, 'Bosta linked refresh failed');
    }
  }

  // Phone-match auto-link removed: COD + date guesses attached old WooCommerce
  // deliveries to newly verified orders and jumped Ready → Delivered before
  // warehouse pick & pack. Shipments are created only via print-policy / pick-pack
  // (businessReference = Mongo order id); sync only refreshes already-linked rows.

  logger.info(results, 'Bosta order-state sync finished');
  return results;
}

const BACKFILL_STATES = [
  'Delivered',
  'Returned to business',
  'Terminated',
  'Exception',
  'Canceled',
];

/**
 * Bulk ingest Bosta delivery states into OMS from a start date (e.g. 2026-07-01).
 * Pages Bosta by dashboard state labels, matches Gazelle orders (ref / tracking / delivery id),
 * then applies the same path as webhooks so COD + status land correctly.
 */
export async function backfillBostaSince({
  since = '2026-07-01',
  endDate = null,
  maxPagesPerState = 40,
} = {}) {
  if (!isBostaConfigured()) {
    return { skipped: 'bosta_not_configured' };
  }

  const sinceDate = new Date(since);
  if (Number.isNaN(sinceDate.getTime())) {
    const err = new Error('Invalid since date');
    err.statusCode = 400;
    throw err;
  }
  const end = endDate ? new Date(endDate) : new Date();
  const startYmd = sinceDate.toISOString().slice(0, 10);
  const endYmd = end.toISOString().slice(0, 10);

  const results = {
    since: sinceDate.toISOString(),
    end: end.toISOString(),
    fetched: 0,
    linked: 0,
    synced: 0,
    codStamped: 0,
    unmatched: 0,
    errors: [],
  };

  const usedDeliveryIds = new Set(
    (await Order.find({ bostaDeliveryId: { $ne: null } }).distinct('bostaDeliveryId')).map(String)
  );

  const orders = await Order.find({
    placedAt: { $gte: sinceDate },
    shippingMethod: { $ne: 'pickup' },
    internalStatus: { $ne: 'cancelled' },
  }).select(
    '_id shopifyOrderId placedAt paymentMethod totalSellingPrice shippingFee shippingAddress internalStatus bostaDeliveryId bostaTrackingNumber bostaShipmentStatus bostaCollectedAmount customerId'
  );

  const byId = new Map(orders.map((o) => [String(o._id), o]));
  const byTracking = new Map(
    orders.filter((o) => o.bostaTrackingNumber).map((o) => [String(o.bostaTrackingNumber), o])
  );
  const byDelivery = new Map(
    orders.filter((o) => o.bostaDeliveryId).map((o) => [String(o.bostaDeliveryId), o])
  );

  const seenDelivery = new Set();

  for (const stateLabel of BACKFILL_STATES) {
    for (let page = 0; page < maxPagesPerState; page += 1) {
      let list = [];
      try {
        const response = await bostaRequest('/deliveries/search', {
          method: 'POST',
          body: {
            page,
            limit: 50,
            state: stateLabel,
            startDate: startYmd,
            endDate: endYmd,
          },
        });
        list = response?.data?.deliveries || response?.deliveries || [];
      } catch (err) {
        results.errors.push({ state: stateLabel, page, error: err.message });
        logger.warn({ err, state: stateLabel, page }, 'Bosta backfill page failed');
        break;
      }
      if (!list.length) break;

      for (const delivery of list) {
        const deliveryId = String(delivery._id || delivery.id || '');
        if (!deliveryId || seenDelivery.has(deliveryId)) continue;
        seenDelivery.add(deliveryId);
        results.fetched += 1;

        const tracking =
          delivery.trackingNumber != null ? String(delivery.trackingNumber) : null;
        const ref = String(delivery.businessReference || '').trim();

        if (isForeignBostaDelivery(delivery)) {
          results.unmatched += 1;
          continue;
        }

        // Prefer existing Gazelle link / Mongo businessReference only — Shopify numeric
        // refs often belong to WooCommerce and must not auto-link.
        // Match only by existing Gazelle link or Mongo businessReference.
        // Never phone/COD — that jumped ready-to-ship orders to delivered.
        const order =
          byDelivery.get(deliveryId) ||
          (tracking ? byTracking.get(tracking) : null) ||
          (ref && byId.has(ref) ? byId.get(ref) : null) ||
          null;

        if (!order) {
          results.unmatched += 1;
          continue;
        }

        if (order.internalStatus === 'pending_verification' || order.internalStatus === 'no_response') {
          results.unmatched += 1;
          continue;
        }

        if (order.bostaDeliveryId && String(order.bostaDeliveryId) !== deliveryId) {
          // Already linked to a different shipment — never apply this delivery's status.
          results.unmatched += 1;
          continue;
        }

        try {
          usedDeliveryIds.add(deliveryId);
          const beforeCod = order.bostaCollectedAmount || 0;
          await linkAndSyncOrder(order, delivery, `Bosta backfill since ${startYmd}`);
          results.linked += 1;
          results.synced += 1;
          const refreshed = await Order.findById(order._id)
            .select('bostaCollectedAmount')
            .lean();
          if ((refreshed?.bostaCollectedAmount || 0) > beforeCod) results.codStamped += 1;
        } catch (err) {
          results.errors.push({ orderId: order._id, deliveryId, error: err.message });
        }
      }

      if (list.length < 50) break;
    }
  }

  // Also refresh every already-linked order in the window (catches mid-flight states).
  const linkedRefresh = await syncOrderStatesFromBosta({
    limit: Math.max(orders.filter((o) => o.bostaDeliveryId).length, 50),
    since: sinceDate,
  });
  results.linkedRefresh = linkedRefresh;

  logger.info(results, 'Bosta backfill since date finished');
  return results;
}

export default { syncOrderStatesFromBosta, backfillBostaSince };
