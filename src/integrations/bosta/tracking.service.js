import Order from '../../models/Order.js';
import BostaStatusMapping from '../../models/BostaStatusMapping.js';
import { getDelivery } from './shipments.service.js';
import orderService from '../../services/order.service.js';
import logger from '../../utils/logger.js';

function asFiniteNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  // Sometimes amounts come nested: { amount: "123" }
  if (typeof v === 'object') {
    const inner = v.amount ?? v.value ?? v.total;
    return asFiniteNumber(inner);
  }
  return null;
}

function extractBostaCollectedAmount(payload) {
  if (!payload) return null;

  // Best-effort: Bosta may echo COD via `cod` in payloads.
  const candidates = [
    payload.cod,
    payload.codAmount,
    payload.cod_amount,
    payload.collectedAmount,
    payload.collected_amount,
    payload.amount,
    payload.totalAmount,
    payload.total_amount,
  ];

  for (const c of candidates) {
    const n = asFiniteNumber(c);
    if (n != null) return n;
  }

  // Nested payment objects.
  const payment = payload.payment || payload.payments || payload.codPayment;
  if (payment) return extractBostaCollectedAmount(payment);

  return null;
}

export async function mapBostaStateToInternal(bostaState) {
  const mapping = await BostaStatusMapping.findOne({
    bostaState: { $regex: new RegExp(`^${bostaState}$`, 'i') },
    isActive: true,
  });
  return mapping?.internalStatus || null;
}

export async function processBostaStatusUpdate({ deliveryId, state, payload, note }) {
  const order = await Order.findOne({ bostaDeliveryId: deliveryId });
  if (!order) {
    logger.warn({ deliveryId }, 'Bosta webhook for unknown delivery');
    return null;
  }

  const internalStatus = await mapBostaStateToInternal(state);
  if (!internalStatus) {
    logger.warn({ state, deliveryId }, 'Unmapped Bosta state');
    return order;
  }

  // Persist the best-effort collected COD amount once the delivery is delivered.
  if (internalStatus === 'delivered') {
    const collected = extractBostaCollectedAmount(payload);
    if (collected != null && collected >= 0 && (!order.bostaCollectedAmount || order.bostaCollectedAmount === 0)) {
      order.bostaCollectedAmount = collected;
      order.bostaCollectedAt = new Date();
      await order.save();
    }
  }

  if (order.internalStatus === internalStatus) {
    return order;
  }

  return orderService.transitionOrderStatus(order._id, internalStatus, {
    source: 'bosta_webhook',
    note: note || `Bosta state: ${state}`,
  });
}

export async function pollStuckOrders(thresholdHours = 48) {
  const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);
  const stuck = await Order.find({
    internalStatus: {
      $in: ['picked_up_by_bosta', 'in_transit', 'failed_delivery', 'returning_to_origin'],
    },
    lastStatusUpdateAt: { $lt: cutoff },
    bostaDeliveryId: { $exists: true, $ne: null },
  }).limit(50);

  const results = [];
  for (const order of stuck) {
    try {
      const delivery = await getDelivery(order.bostaDeliveryId);
      const state = delivery?.state || delivery?.status;
      if (state) {
        await processBostaStatusUpdate({
          deliveryId: order.bostaDeliveryId,
          state,
          payload: delivery,
          note: 'Polling fallback',
        });
        results.push({ orderId: order._id, state });
      }
    } catch (err) {
      logger.error({ err, orderId: order._id }, 'Bosta polling failed');
    }
  }
  return results;
}

export default { mapBostaStateToInternal, processBostaStatusUpdate, pollStuckOrders };
