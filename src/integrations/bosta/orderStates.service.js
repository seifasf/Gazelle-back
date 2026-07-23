import Order from '../../models/Order.js';
import '../../models/Customer.js';
import { bostaRequest, isBostaConfigured } from './client.js';
import { getDelivery } from './shipments.service.js';
import { processBostaStatusUpdate } from './tracking.service.js';
import logger from '../../utils/logger.js';

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('20') && digits.length >= 12) return digits.slice(-10);
  if (digits.startsWith('0') && digits.length >= 11) return digits.slice(1);
  return digits.slice(-10);
}

function deliveryCod(delivery) {
  if (typeof delivery?.cod === 'number') return delivery.cod;
  return Number(delivery?.cod?.amount ?? delivery?.codAmount ?? 0) || 0;
}

/** Foreign channels (old Woo store, etc.) must never auto-link onto Gazelle Shopify orders. */
function isForeignBostaDelivery(delivery) {
  const src = String(delivery?.creationSrc || delivery?.source || '').toUpperCase();
  if (src === 'WOOCOMMERCE' || src === 'WOO') return true;
  const ref = String(delivery?.businessReference || '').trim().toLowerCase();
  if (ref.startsWith('woocommerce') || ref.startsWith('woo_') || ref.startsWith('woo-')) return true;
  return false;
}

function scoreDeliveryMatch(order, delivery) {
  if (isForeignBostaDelivery(delivery)) return -999;

  let score = 0;
  const ref = String(delivery.businessReference || '').trim();
  const orderId = String(order._id);
  const shopifyId = String(order.shopifyOrderId || '');

  if (ref && (ref === orderId || ref === shopifyId)) score += 100;
  if (ref && shopifyId && ref.includes(shopifyId)) score += 80;

  const due = (order.totalSellingPrice || 0) + (order.shippingFee || 0);
  const cod = deliveryCod(delivery);
  if (due > 0 && Math.abs(cod - due) <= 1) score += 45;
  else if (due > 0 && order.paymentMethod === 'online' && cod === 0) score += 15;
  else if (due > 0 && cod > 0 && Math.abs(cod - due) > 50) score -= 30;

  const placed = order.placedAt ? new Date(order.placedAt).getTime() : null;
  const created = delivery.createdAt ? new Date(delivery.createdAt).getTime() : null;
  if (placed && created && Number.isFinite(created)) {
    const days = Math.abs(created - placed) / (1000 * 60 * 60 * 24);
    if (days <= 2) score += 30;
    else if (days <= 5) score += 15;
    else if (days > 14) score -= 40;
  }

  return score;
}

async function searchDeliveriesByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];

  const variants = [normalized, `0${normalized}`, `+20${normalized}`, `20${normalized}`];
  const byId = new Map();
  for (const phoneValue of variants) {
    try {
      const response = await bostaRequest('/deliveries/search', {
        method: 'POST',
        body: { page: 0, limit: 25, phone: phoneValue },
      });
      const list = response?.data?.deliveries || response?.deliveries || [];
      for (const d of list) byId.set(String(d._id || d.id), d);
    } catch (err) {
      logger.warn({ err, phoneValue }, 'Bosta phone search failed');
    }
  }
  return [...byId.values()];
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
  const deliveryId = String(delivery._id || delivery.id);
  const tracking =
    delivery.trackingNumber != null ? String(delivery.trackingNumber) : order.bostaTrackingNumber;

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
 * Pull live Bosta states into OMS orders.
 * Matches carefully (COD + date / reference) and never reuses one Bosta delivery on two OMS orders.
 *
 * @param {{ limit?: number, since?: Date|string|null }} opts
 *   since — when set, only OMS orders placed on/after this date (and prefer Bosta
 *   deliveries created in the same window).
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

  const usedDeliveryIds = new Set(
    (
      await Order.find({ bostaDeliveryId: { $ne: null } }).distinct('bostaDeliveryId')
    ).map(String)
  );

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

  // 2) Link unlinked orders with high-confidence phone matches.
  // Skip pending_verification — Bosta must not attach/advance until a human verifies.
  const unlinkedFilter = {
    $or: [{ bostaDeliveryId: null }, { bostaDeliveryId: { $exists: false } }],
    shippingMethod: { $ne: 'pickup' },
    internalStatus: {
      $in: [
        'verified_ready_for_shipping',
        'picked_up_by_bosta',
        'in_transit',
        'failed_delivery',
        'returning_to_origin',
        'returned_awaiting_receipt',
        'delivered',
      ],
    },
  };
  if (sinceOk) unlinkedFilter.placedAt = { $gte: sinceOk };

  const unlinked = await Order.find(unlinkedFilter)
    .sort({ placedAt: -1 })
    .limit(limit)
    .populate('customerId', 'phone')
    .select(
      '_id shopifyOrderId placedAt paymentMethod totalSellingPrice shippingFee shippingAddress internalStatus bostaDeliveryId bostaTrackingNumber bostaShipmentStatus customerId'
    );

  for (const order of unlinked) {
    try {
      const phone = order.shippingAddress?.phone || order.customerId?.phone;
      const deliveries = await searchDeliveriesByPhone(phone);
      if (!deliveries.length) {
        results.unmatched += 1;
        continue;
      }

      let best = null;
      let bestScore = -Infinity;
      for (const d of deliveries) {
        const id = String(d._id || d.id);
        if (usedDeliveryIds.has(id)) continue;
        const score = scoreDeliveryMatch(order, d);
        if (score > bestScore) {
          bestScore = score;
          best = d;
        }
      }

      // Require strong confidence (COD/date or explicit reference).
      if (!best || bestScore < 55) {
        results.unmatched += 1;
        continue;
      }

      const deliveryId = String(best._id || best.id);
      usedDeliveryIds.add(deliveryId);

      const synced = await linkAndSyncOrder(order, best, 'Bosta state sync (phone match)');
      results.linked += 1;
      if (synced.synced) results.synced += 1;
      if (results.samples.length < 8) results.samples.push({ ...synced, score: bestScore });
    } catch (err) {
      results.errors.push({ orderId: order._id, error: err.message });
      logger.warn({ err, orderId: order._id }, 'Bosta unlinked sync failed');
    }
  }

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
 * Pages Bosta by dashboard state labels, matches Gazelle orders (ref / tracking / phone+COD+date),
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
  })
    .populate('customerId', 'phone')
    .select(
      '_id shopifyOrderId placedAt paymentMethod totalSellingPrice shippingFee shippingAddress internalStatus bostaDeliveryId bostaTrackingNumber bostaShipmentStatus bostaCollectedAmount customerId'
    );

  const byId = new Map(orders.map((o) => [String(o._id), o]));
  const byShopify = new Map(
    orders.filter((o) => o.shopifyOrderId).map((o) => [String(o.shopifyOrderId), o])
  );
  const byTracking = new Map(
    orders.filter((o) => o.bostaTrackingNumber).map((o) => [String(o.bostaTrackingNumber), o])
  );
  const byDelivery = new Map(
    orders.filter((o) => o.bostaDeliveryId).map((o) => [String(o.bostaDeliveryId), o])
  );
  const byPhone = new Map();
  for (const o of orders) {
    const ph = normalizePhone(o.shippingAddress?.phone || o.customerId?.phone);
    if (!ph) continue;
    if (!byPhone.has(ph)) byPhone.set(ph, []);
    byPhone.get(ph).push(o);
  }

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

        let order =
          byDelivery.get(deliveryId) ||
          (tracking ? byTracking.get(tracking) : null) ||
          (ref && byId.has(ref) ? byId.get(ref) : null) ||
          (ref && byShopify.has(ref) ? byShopify.get(ref) : null) ||
          null;

        if (!order) {
          const ph = normalizePhone(delivery.receiver?.phone);
          const candidates = ph ? byPhone.get(ph) || [] : [];
          let best = null;
          let bestScore = -Infinity;
          for (const c of candidates) {
            if (c.bostaDeliveryId && usedDeliveryIds.has(String(c.bostaDeliveryId))) {
              if (String(c.bostaDeliveryId) !== deliveryId) continue;
            }
            const score = scoreDeliveryMatch(c, delivery);
            if (score > bestScore) {
              bestScore = score;
              best = c;
            }
          }
          if (best && bestScore >= 55) order = best;
        }

        if (!order) {
          results.unmatched += 1;
          continue;
        }

        if (order.bostaDeliveryId && String(order.bostaDeliveryId) !== deliveryId) {
          // Already linked to a different shipment — skip to avoid clobbering.
          if (usedDeliveryIds.has(deliveryId)) {
            results.unmatched += 1;
            continue;
          }
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
