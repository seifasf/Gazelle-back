import Order from '../../models/Order.js';
import BostaStatusMapping from '../../models/BostaStatusMapping.js';
import { getDelivery } from './shipments.service.js';
import orderService from '../../services/order.service.js';
import logger from '../../utils/logger.js';
import {
  extractBostaStateTokens,
  extractBostaStateCode,
  defaultInternalStatusForState,
  resolveInternalStatusForBosta,
  isReturnState,
  normalizeBostaType,
  parseBostaDate,
} from './states.js';
import { canTransition } from '../../services/orderStateMachine.js';

/** Foreign channels (old Woo store, etc.) must never drive Gazelle order status. */
function isForeignBostaDelivery(delivery) {
  const src = String(delivery?.creationSrc || delivery?.source || '').toUpperCase();
  if (src === 'WOOCOMMERCE' || src === 'WOO') return true;
  const ref = String(
    delivery?.businessReference || delivery?.business_reference || ''
  )
    .trim()
    .toLowerCase();
  if (ref.startsWith('woocommerce') || ref.startsWith('woo_') || ref.startsWith('woo-')) {
    return true;
  }
  return false;
}

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

/** Prefer webhook timeStamp (ms), then nested state delivery times. */
function extractBostaEventAt(payload, state) {
  const ts = payload?.timeStamp ?? payload?.timestamp;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof ts === 'string' && /^\d+$/.test(ts)) {
    const d = new Date(Number(ts));
    if (!Number.isNaN(d.getTime())) return d;
  }
  const fromState =
    parseBostaDate(state?.deliveryTime) ||
    parseBostaDate(state?.delivering?.time) ||
    parseBostaDate(state?.returnedToBusiness) ||
    parseBostaDate(state?.terminated);
  if (fromState) return fromState;
  return parseBostaDate(payload?.updatedAt) || parseBostaDate(payload?.createdAt) || new Date();
}

export async function mapBostaStateToInternal(bostaState, meta = {}) {
  const code = extractBostaStateCode(bostaState);
  // Type-sensitive codes must follow webhook docs (not stale DB seed rows).
  if (
    code === 41 ||
    code === 47 ||
    code === 22 ||
    code === 23 ||
    (meta?.type && normalizeBostaType(meta.type))
  ) {
    const resolved = resolveInternalStatusForBosta(bostaState, meta);
    if (resolved) return resolved;
  }

  const tokens = extractBostaStateTokens(bostaState);
  for (const token of tokens) {
    const mapping = await BostaStatusMapping.findOne({
      bostaState: { $regex: new RegExp(`^${String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      isActive: true,
    });
    if (mapping?.internalStatus) return mapping.internalStatus;
  }

  return (
    resolveInternalStatusForBosta(bostaState, meta) ||
    defaultInternalStatusForState(bostaState)
  );
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

  // Gazelle creates use businessReference = Mongo order._id only.
  // Do NOT match by shopifyOrderId — WooCommerce / old-plugin shipments reuse
  // numeric Shopify ids and would hijack OMS status after verify.
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
    // pending_verification is intentionally omitted — humans must verify first.
    picked_up_by_bosta: {
      delivered: ['in_transit'],
      failed_delivery: ['in_transit'],
      // Prefer RTO path without forcing failed_delivery (clean returns).
      returning_to_origin: ['in_transit'],
      returned_awaiting_receipt: ['in_transit', 'returning_to_origin'],
    },
    in_transit: {
      returning_to_origin: [],
      returned_awaiting_receipt: ['returning_to_origin'],
    },
    verified_ready_for_shipping: {
      in_transit: ['picked_up_by_bosta'],
      delivered: ['picked_up_by_bosta', 'in_transit'],
      failed_delivery: ['picked_up_by_bosta', 'in_transit'],
      returning_to_origin: ['picked_up_by_bosta', 'in_transit'],
      returned_awaiting_receipt: ['picked_up_by_bosta', 'in_transit', 'returning_to_origin'],
    },
    delivered: {
      returned_awaiting_receipt: ['returning_to_origin'],
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

  if (isForeignBostaDelivery(payload)) {
    logger.warn(
      {
        orderId: order._id,
        deliveryId,
        creationSrc: payload?.creationSrc || payload?.source,
        businessReference: payload?.businessReference || payload?.business_reference,
      },
      'Ignoring foreign Bosta delivery update'
    );
    return order;
  }

  const incomingId = deliveryId ? String(deliveryId) : null;
  const linkedId = order.bostaDeliveryId ? String(order.bostaDeliveryId) : null;
  const tracking =
    payload?.trackingNumber != null
      ? String(payload.trackingNumber)
      : payload?.tracking_number != null
        ? String(payload.tracking_number)
        : null;

  // Order already has a Gazelle link — never apply another delivery's status.
  if (linkedId && incomingId && linkedId !== incomingId) {
    logger.warn(
      { orderId: order._id, linkedId, incomingId },
      'Ignoring Bosta update for non-linked delivery'
    );
    return order;
  }
  if (
    order.bostaTrackingNumber &&
    tracking &&
    String(order.bostaTrackingNumber) !== tracking &&
    (!incomingId || !linkedId || linkedId !== incomingId)
  ) {
    logger.warn(
      {
        orderId: order._id,
        linkedTracking: order.bostaTrackingNumber,
        incomingTracking: tracking,
      },
      'Ignoring Bosta update for mismatched tracking'
    );
    return order;
  }

  // Call-center / stock must verify first. Never attach or advance while pending.
  if (order.internalStatus === 'pending_verification') {
    logger.info(
      {
        orderId: order._id,
        deliveryId,
        state: extractBostaStateTokens(state).join('/') || String(state),
        type: normalizeBostaType(payload?.type ?? null),
      },
      'Ignoring Bosta status while order is still pending_verification'
    );
    return order;
  }

  // Attach delivery id / tracking only after verify, and only when still unlinked.
  const updates = {};
  if (incomingId && !order.bostaDeliveryId) updates.bostaDeliveryId = incomingId;
  if (tracking && !order.bostaTrackingNumber) updates.bostaTrackingNumber = tracking;
  if (Object.keys(updates).length) {
    Object.assign(order, updates);
    await order.save();
  }

  const stateCode = extractBostaStateCode(state);
  const stateLabel = extractBostaStateTokens(state).join('/') || String(state);
  const type = payload?.type ?? null;
  const exceptionCode = payload?.exceptionCode ?? payload?.exception_code ?? null;
  const internalStatus = await mapBostaStateToInternal(state, { type, exceptionCode });
  if (!internalStatus) {
    logger.warn({ state: stateLabel, stateCode, deliveryId, type }, 'Unmapped Bosta state');
    return order;
  }

  // Docs: `cod` is sent on Delivered. Stamp amount + webhook timeStamp onto the order.
  if (internalStatus === 'delivered' && !isReturnState(state)) {
    const collected = extractBostaCollectedAmount(payload);
    if (collected != null && collected >= 0) {
      const eventAt = extractBostaEventAt(payload, typeof state === 'object' ? state : null);
      const shouldWrite =
        !order.bostaCollectedAmount ||
        order.bostaCollectedAmount === 0 ||
        collected > order.bostaCollectedAmount;
      if (shouldWrite) {
        order.bostaCollectedAmount = collected;
        order.bostaCollectedAt = eventAt;
        await order.save();
      }
    }
  }

  if (order.internalStatus === internalStatus) {
    return order;
  }

  // Shopify-imported "delivered" can still move into failure / return lanes from Bosta.
  if (
    order.internalStatus === 'delivered' &&
    !['returning_to_origin', 'returned_awaiting_receipt', 'failed_delivery'].includes(internalStatus)
  ) {
    logger.info(
      { orderId: order._id, state: stateLabel, internalStatus, type: normalizeBostaType(type) },
      'Ignoring Bosta update on delivered order'
    );
    return order;
  }

  // Never move backwards (e.g. in_transit → picked_up_by_bosta).
  if (
    order.internalStatus === 'in_transit' &&
    internalStatus === 'picked_up_by_bosta'
  ) {
    return order;
  }

  try {
    const updated = await transitionToward(order._id, order.internalStatus, internalStatus, {
      source: 'bosta_webhook',
      note: note || `Bosta state: ${stateLabel}${normalizeBostaType(type) ? ` (${normalizeBostaType(type)})` : ''}`,
    });
    logger.info(
      {
        orderId: order._id,
        deliveryId,
        from: order.internalStatus,
        to: internalStatus,
        state: stateLabel,
        type: normalizeBostaType(type),
      },
      'Bosta status applied to order'
    );
    return updated;
  } catch (err) {
    logger.warn(
      { err, orderId: order._id, from: order.internalStatus, to: internalStatus, state: stateLabel },
      'Bosta status transition failed'
    );
    return order;
  }
}

export async function pollStuckOrders(thresholdHours = 2) {
  const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);
  const stuck = await Order.find({
    bostaDeliveryId: { $exists: true, $ne: null },
    internalStatus: {
      $in: [
        'verified_ready_for_shipping',
        'picked_up_by_bosta',
        'in_transit',
        'failed_delivery',
        'returning_to_origin',
        'returned_awaiting_receipt',
      ],
    },
    $or: [
      { lastStatusUpdateAt: { $lt: cutoff } },
      { lastStatusUpdateAt: { $exists: false } },
      { lastStatusUpdateAt: null },
    ],
  }).limit(100);

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
