import Order from '../../models/Order.js';
import { resolveBostaCourierFee } from '../../constants/shippingZones.js';
import { isBostaConfigured } from './client.js';
import { getDelivery } from './shipments.service.js';
import {
  buildCalculatorParamsForOrder,
  calculateShipmentFees,
  parseBostaFeeBreakdownFromDelivery,
} from './pricing.service.js';
import logger from '../../utils/logger.js';

const STALE_MS = 6 * 60 * 60 * 1000;

/** Fee sources that came from a Bosta API (not Gazelle zone estimates). */
export const BOSTA_API_FEE_SOURCES = new Set(['delivery', 'calculator']);

export function resolveBostaCourierFeeForOrder(order) {
  const breakdownTotal = Number(order?.bostaFeeBreakdown?.total);
  if (Number.isFinite(breakdownTotal) && breakdownTotal > 0) return breakdownTotal;
  return resolveBostaCourierFee(order);
}

/** True when stored breakdown is from Bosta delivery or pricing calculator API. */
export function isBostaApiFeeBreakdown(breakdown) {
  if (!breakdown || !(Number(breakdown.total) > 0)) return false;
  const src = String(breakdown.source || '').toLowerCase();
  if (!src) return true; // legacy rows synced before source was set
  if (src === 'zone' || src === 'estimate' || src === 'fallback') return false;
  return BOSTA_API_FEE_SOURCES.has(src) || src === 'delivery' || src === 'calculator';
}

function breakdownIsFresh(breakdown) {
  if (!isBostaApiFeeBreakdown(breakdown) || !breakdown.fetchedAt) return false;
  const age = Date.now() - new Date(breakdown.fetchedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < STALE_MS;
}

function orderHasBostaShipment(order) {
  if (!order) return false;
  const method = order.shippingMethod;
  if (method === 'local_shipping' || method === 'pickup') return false;
  return (
    method === 'bosta' ||
    Boolean(order.bostaTrackingNumber) ||
    Boolean(order.bostaDeliveryId)
  );
}

/**
 * Pull real fees from Bosta for one order.
 * 1) GET delivery by tracking / delivery id (wallet + invoice lines)
 * 2) Optional: Bosta /pricing/shipment/calculator
 * Never writes Gazelle zone estimates into bostaFeeBreakdown.
 */
export async function syncBostaFeesForOrder(
  order,
  { force = false, allowCalculator = true } = {}
) {
  if (!orderHasBostaShipment(order)) return null;
  if (!isBostaConfigured()) return isBostaApiFeeBreakdown(order.bostaFeeBreakdown)
    ? order.bostaFeeBreakdown
    : null;

  const existing = order.bostaFeeBreakdown;
  const looksIncomplete =
    existing &&
    Number(existing.total) > 0 &&
    Number(existing.shippingFee || 0) === 0 &&
    Number(existing.insuranceFee || 0) > 0 &&
    Number(existing.total) <= 25;
  if (!force && !looksIncomplete && breakdownIsFresh(existing)) return existing;

  let breakdown = null;
  const lookupKey = order.bostaTrackingNumber || order.bostaDeliveryId;

  if (lookupKey) {
    try {
      const delivery = await getDelivery(String(lookupKey));
      breakdown = parseBostaFeeBreakdownFromDelivery(delivery);
    } catch (err) {
      logger.debug(
        { orderId: String(order._id), err: err.message },
        'Bosta delivery fee parse skipped'
      );
    }
  }

  if (!breakdown?.total && allowCalculator) {
    const params = buildCalculatorParamsForOrder({
      ...((order && typeof order.toObject === 'function')
        ? order.toObject()
        : order),
      shippingMethod: order.shippingMethod || 'bosta',
    });
    if (params) {
      try {
        breakdown = await calculateShipmentFees(params);
      } catch (err) {
        logger.warn(
          { orderId: String(order._id), err: err.message },
          'Bosta pricing calculator failed'
        );
      }
    }
  }

  if (breakdown?.total > 0) {
    await Order.updateOne(
      { _id: order._id },
      { $set: { bostaFeeBreakdown: breakdown, bostaCourierFee: breakdown.total } }
    );
    if (order && typeof order === 'object') {
      order.bostaFeeBreakdown = breakdown;
      order.bostaCourierFee = breakdown.total;
    }
    return breakdown;
  }

  return isBostaApiFeeBreakdown(existing) ? existing : null;
}

/**
 * Concurrently sync Bosta fee breakdowns for an array of orders.
 */
export async function syncBostaFeesForOrders(
  orders,
  { concurrency = 5, force = false, allowCalculator = true } = {}
) {
  if (!Array.isArray(orders) || !orders.length) {
    return { results: [], synced: 0, fromDelivery: 0, fromCalculator: 0, missing: 0 };
  }
  const results = [];
  const queue = [...orders];
  let synced = 0;
  let fromDelivery = 0;
  let fromCalculator = 0;
  let missing = 0;

  async function worker() {
    while (queue.length > 0) {
      const order = queue.shift();
      if (!order) break;
      try {
        const res = await syncBostaFeesForOrder(order, { force, allowCalculator });
        const src = String(res?.source || '').toLowerCase();
        if (res?.total > 0) {
          synced += 1;
          if (src === 'delivery') fromDelivery += 1;
          else if (src === 'calculator') fromCalculator += 1;
        } else {
          missing += 1;
        }
        results.push({ orderId: order._id, breakdown: res });
      } catch (err) {
        missing += 1;
        logger.debug({ orderId: order._id, err: err.message }, 'Batch Bosta fee sync failed');
        results.push({ orderId: order._id, breakdown: null, error: err.message });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, orders.length) }, () => worker());
  await Promise.all(workers);
  return { results, synced, fromDelivery, fromCalculator, missing, attempted: orders.length };
}

/** Attach live Bosta fee breakdown + total on order API payloads. */
export async function enrichBostaFeeFields(order, { refresh = true } = {}) {
  const data =
    order && typeof order.toObject === 'function'
      ? order.toObject({ virtuals: true })
      : { ...order };

  if (refresh && orderHasBostaShipment(data)) {
    const synced = await syncBostaFeesForOrder(data, {
      force: !isBostaApiFeeBreakdown(data.bostaFeeBreakdown),
    });
    if (synced) data.bostaFeeBreakdown = synced;
  }

  data.bostaCourierFee = resolveBostaCourierFeeForOrder(data);
  return data;
}

export default {
  syncBostaFeesForOrder,
  syncBostaFeesForOrders,
  enrichBostaFeeFields,
  resolveBostaCourierFeeForOrder,
  isBostaApiFeeBreakdown,
};
