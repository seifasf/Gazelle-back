import Order from '../../models/Order.js';
import BostaStatusMapping from '../../models/BostaStatusMapping.js';
import { getDelivery } from './shipments.service.js';
import orderService from '../../services/order.service.js';
import logger from '../../utils/logger.js';
import {
  extractBostaStateTokens,
  extractBostaStateCode,
  defaultInternalStatusForState,
  isReturnState,
} from './states.js';
import { canTransition } from '../../services/orderStateMachine.js';

function asFiniteNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object') {
    const inner = v.amount ?? v.value ?? v.total;
    return asFiniteNumber(inner);
  }
  return null;
}

function extractBostaCollectedAmount(payload) {
  if (!payload) return null;

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

  const payment = payload.payment || payload.payments || payload.codPayment;
  if (payment) return extractBostaCollectedAmount(payment);

  return null;
}

export async function mapBostaStateToInternal(bostaState) {
  const tokens = extractBostaStateTokens(bostaState);
  for (const token of tokens) {
    const mapping = await BostaStatusMapping.findOne({
      bostaState: { $regex: new RegExp(`^${String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      isActive: true,
    });
    if (mapping?.internalStatus) return mapping.internalStatus;
  }

  return defaultInternalStatusForState(bostaState);
}

async function findOrderForBostaPayload({ deliveryId, payload }) {
  if (deliveryId) {
    const byId = await Order.findOne({ bostaDeliveryId: String(deliveryId) });
    if (byId) return byId;
  }

  const tracking =
    payload?.trackingNumber != null
      ? String(payload.trackingNumber)
      : payload?.tracking_number != null
        ? String(payload.tracking_number)
        : null;
  if (tracking) {
    const byTracking = await Order.findOne({ bostaTrackingNumber: tracking });
    if (byTracking) return byTracking;
  }

  const ref = String(payload?.businessReference || payload?.business_reference || '').trim();
  if (ref && /^[a-f\d]{24}$/i.test(ref)) {
    const byRef = await Order.findById(ref);
    if (byRef) return byRef;
  }

  return null;
}

/**
 * Walk allowed intermediate statuses when Bosta jumps ahead
 * (e.g. picked_up → returning_to_origin without failed_delivery).
 */
async function transitionToward(orderId, fromStatus, toStatus, meta) {
  if (fromStatus === toStatus) return null;
  if (canTransition(fromStatus, toStatus)) {
    return orderService.transitionOrderStatus(orderId, toStatus, meta);
  }

  const bridges = {
    picked_up_by_bosta: {
      delivered: ['in_transit'],
      failed_delivery: ['in_transit'],
      returning_to_origin: ['in_transit', 'failed_delivery'],
    },
    in_transit: {
      returning_to_origin: ['failed_delivery'],
    },
    verified_ready_for_shipping: {
      in_transit: ['picked_up_by_bosta'],
      delivered: ['picked_up_by_bosta', 'in_transit'],
      failed_delivery: ['picked_up_by_bosta', 'in_transit'],
      returning_to_origin: ['picked_up_by_bosta', 'in_transit', 'failed_delivery'],
    },
  };

  const path = bridges[fromStatus]?.[toStatus];
  if (!path) {
    const err = new Error(`Invalid transition: ${fromStatus} → ${toStatus}`);
    err.statusCode = 400;
    throw err;
  }

  let current = fromStatus;
  let last = null;
  for (const step of [...path, toStatus]) {
    if (current === step) continue;
    if (!canTransition(current, step)) {
      const err = new Error(`Invalid transition: ${current} → ${step}`);
      err.statusCode = 400;
      throw err;
    }
    last = await orderService.transitionOrderStatus(orderId, step, {
      ...meta,
      note: meta.note ? `${meta.note} (via ${step})` : `Bosta bridge → ${step}`,
    });
    current = step;
  }
  return last;
}

export async function processBostaStatusUpdate({ deliveryId, state, payload, note }) {
  const order = await findOrderForBostaPayload({ deliveryId, payload });
  if (!order) {
    logger.warn({ deliveryId, state }, 'Bosta webhook for unknown delivery');
    return null;
  }

  // Attach delivery id / tracking if we matched via businessReference or tracking only.
  const updates = {};
  if (deliveryId && !order.bostaDeliveryId) updates.bostaDeliveryId = String(deliveryId);
  const tracking =
    payload?.trackingNumber != null
      ? String(payload.trackingNumber)
      : payload?.tracking_number != null
        ? String(payload.tracking_number)
        : null;
  if (tracking && !order.bostaTrackingNumber) updates.bostaTrackingNumber = tracking;
  if (Object.keys(updates).length) {
    Object.assign(order, updates);
    await order.save();
  }

  const stateCode = extractBostaStateCode(state);
  const stateLabel = extractBostaStateTokens(state).join('/') || String(state);
  const internalStatus = await mapBostaStateToInternal(state);
  if (!internalStatus) {
    logger.warn({ state: stateLabel, stateCode, deliveryId }, 'Unmapped Bosta state');
    return order;
  }

  if (internalStatus === 'delivered' && !isReturnState(state)) {
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

  // Do not reopen terminal delivered orders except for return signals.
  if (order.internalStatus === 'delivered' && internalStatus !== 'returning_to_origin') {
    logger.info(
      { orderId: order._id, state: stateLabel, internalStatus },
      'Ignoring Bosta update on delivered order'
    );
    return order;
  }

  try {
    return await transitionToward(order._id, order.internalStatus, internalStatus, {
      source: 'bosta_webhook',
      note: note || `Bosta state: ${stateLabel}`,
    });
  } catch (err) {
    logger.warn(
      { err, orderId: order._id, from: order.internalStatus, to: internalStatus, state: stateLabel },
      'Bosta status transition failed'
    );
    return order;
  }
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
      const payload = delivery?.data || delivery;
      const state = payload?.state || payload?.status;
      if (state) {
        await processBostaStatusUpdate({
          deliveryId: order.bostaDeliveryId,
          state,
          payload,
          note: 'Polling fallback',
        });
        results.push({ orderId: order._id, state: extractBostaStateTokens(state).join('/') });
      }
    } catch (err) {
      logger.error({ err, orderId: order._id }, 'Bosta polling failed');
    }
  }
  return results;
}

export default { mapBostaStateToInternal, processBostaStatusUpdate, pollStuckOrders };
