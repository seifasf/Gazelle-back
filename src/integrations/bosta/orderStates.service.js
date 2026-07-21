import Order from '../../models/Order.js';
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

function scoreDeliveryMatch(order, delivery) {
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

  const fresh = await resolveLiveDelivery(order, delivery);
  const state = fresh?.state || fresh?.status || delivery.state;
  if (!state) return { orderId: order._id, linked: true, synced: false, reason: 'no_state' };

  await processBostaStatusUpdate({
    deliveryId: order.bostaDeliveryId || deliveryId,
    state,
    payload: fresh || delivery,
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
 */
export async function syncOrderStatesFromBosta({ limit = 80 } = {}) {
  if (!isBostaConfigured()) {
    return { skipped: 'bosta_not_configured' };
  }

  const results = {
    refreshed: 0,
    linked: 0,
    synced: 0,
    unmatched: 0,
    errors: [],
    samples: [],
  };

  const usedDeliveryIds = new Set(
    (
      await Order.find({ bostaDeliveryId: { $ne: null } }).distinct('bostaDeliveryId')
    ).map(String)
  );

  // 1) Refresh already-linked shipments via tracking number.
  const linkedOrders = await Order.find({
    $or: [
      { bostaDeliveryId: { $exists: true, $ne: null } },
      { bostaTrackingNumber: { $exists: true, $ne: null } },
    ],
    internalStatus: { $nin: ['cancelled', 'returned_to_stock'] },
  })
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
  const unlinked = await Order.find({
    $or: [{ bostaDeliveryId: null }, { bostaDeliveryId: { $exists: false } }],
    shippingMethod: { $ne: 'pickup' },
    internalStatus: {
      $in: [
        'pending_verification',
        'verified_ready_for_shipping',
        'picked_up_by_bosta',
        'in_transit',
        'failed_delivery',
        'returning_to_origin',
        'returned_awaiting_receipt',
        'delivered',
      ],
    },
  })
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

export default { syncOrderStatesFromBosta };
