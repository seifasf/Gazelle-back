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

export function resolveBostaCourierFeeForOrder(order) {
  const breakdownTotal = Number(order?.bostaFeeBreakdown?.total);
  if (Number.isFinite(breakdownTotal) && breakdownTotal > 0) return breakdownTotal;
  return resolveBostaCourierFee(order);
}

function breakdownIsFresh(breakdown) {
  if (!breakdown?.total || !breakdown.fetchedAt) return false;
  const age = Date.now() - new Date(breakdown.fetchedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < STALE_MS;
}

export async function syncBostaFeesForOrder(order, { force = false } = {}) {
  if (!order || order.shippingMethod !== 'bosta') return null;
  if (!isBostaConfigured()) return order.bostaFeeBreakdown || null;

  const existing = order.bostaFeeBreakdown;
  if (!force && breakdownIsFresh(existing)) return existing;

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

  if (!breakdown?.total) {
    const params = buildCalculatorParamsForOrder(order);
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
    await Order.updateOne({ _id: order._id }, { $set: { bostaFeeBreakdown: breakdown } });
    return breakdown;
  }

  return existing || null;
}

/** Attach live Bosta fee breakdown + total on order API payloads. */
export async function enrichBostaFeeFields(order, { refresh = true } = {}) {
  const data =
    order && typeof order.toObject === 'function'
      ? order.toObject({ virtuals: true })
      : { ...order };

  if (refresh && data.shippingMethod === 'bosta') {
    const synced = await syncBostaFeesForOrder(data, {
      force: !data.bostaFeeBreakdown?.total,
    });
    if (synced) data.bostaFeeBreakdown = synced;
  }

  data.bostaCourierFee = resolveBostaCourierFeeForOrder(data);
  return data;
}

export default {
  syncBostaFeesForOrder,
  enrichBostaFeeFields,
  resolveBostaCourierFeeForOrder,
};
