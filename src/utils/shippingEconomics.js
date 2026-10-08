/**
 * Shipping economics (from Sep 2026) - real Bosta API money vs what brand collected.
 *
 * Delivered Bosta:
 *   customer shipping collected = order.shippingFee
 *   Bosta cost = live Bosta fee breakdown (delivery API, else pricing calculator)
 *
 * Failed / refused / no-answer / RTO:
 *   customer did NOT pay shipping -> collected = 0
 *   Bosta still charges the brand -> full live fee is shipping loss
 *
 * Left after Bosta = collected - all Bosta fees (delivered + failed/RTO)
 * Shipping loss    = max(0, -Left after Bosta)
 *
 * EGP 25 is COD fee only - never applied here.
 * Gazelle city/zone estimates are never used for shipping loss.
 */

import { rangeEnd, rangeStart, zonedDayBound } from './cairoTime.js';

export const SHIPPING_LOSS_START_YMD = '2026-09-01';

/** Statuses where Bosta may bill the brand but the customer never paid shipping. */
export const BOSTA_FAILED_RTO_STATUSES = [
  'failed_delivery',
  'returning_to_origin',
  'returned_awaiting_receipt',
  'returned_to_stock',
];

export function shippingLossAppliesToRange({ from, to } = {}) {
  const start = zonedDayBound(SHIPPING_LOSS_START_YMD);
  const end = rangeEnd(to);
  if (end && end < start) return false;
  return true;
}

/**
 * Failed / RTO orders for a range, dated by when they FIRST entered a failed/RTO status
 * (status history), not by updatedAt — later edits, return scans or fee syncs must not
 * move an old failure into the current month. Orders with no failed history fall back
 * to updatedAt.
 */
export async function findFailedRtoOrdersForRange({
  Order,
  OrderStatusHistory,
  fromBound,
  rangeTo,
  extraFilter = {},
  select,
}) {
  const firstFailed = await OrderStatusHistory.aggregate([
    { $match: { toStatus: { $in: BOSTA_FAILED_RTO_STATUSES }, createdAt: { $lte: rangeTo } } },
    { $group: { _id: '$orderId', firstFailedAt: { $min: '$createdAt' } } },
    { $match: { firstFailedAt: { $gte: fromBound, $lte: rangeTo } } },
  ]);
  const datedIds = firstFailed.map((row) => row._id);

  const undatedCandidates = await Order.find({
    internalStatus: { $in: BOSTA_FAILED_RTO_STATUSES },
    updatedAt: { $gte: fromBound, $lte: rangeTo },
    ...extraFilter,
  }).select('_id');
  const candidateIds = undatedCandidates.map((o) => o._id);
  const withHistory = candidateIds.length
    ? await OrderStatusHistory.distinct('orderId', {
        orderId: { $in: candidateIds },
        toStatus: { $in: BOSTA_FAILED_RTO_STATUSES },
      })
    : [];
  const hasHistory = new Set(withHistory.map(String));
  const fallbackIds = candidateIds.filter((id) => !hasHistory.has(String(id)));

  const ids = [...datedIds, ...fallbackIds];
  if (!ids.length) return [];
  return Order.find({
    _id: { $in: ids },
    internalStatus: { $in: BOSTA_FAILED_RTO_STATUSES },
    ...extraFilter,
  }).select(select);
}

export function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function isBostaShippingOrder(order) {
  const method = order?.shippingMethod;
  if (method === 'local_shipping' || method === 'pickup') return false;
  return (
    method === 'bosta' ||
    method == null ||
    method === '' ||
    Boolean(order?.bostaTrackingNumber) ||
    Boolean(order?.bostaDeliveryId)
  );
}

export function isFailedRtoStatus(status) {
  return BOSTA_FAILED_RTO_STATUSES.includes(status);
}

/**
 * Prefer stored invoice; optional fallback (zone) for non-shipping-loss callers.
 */
export function resolveRealBostaFee(order, fallbackFn) {
  const breakdownTotal = Number(order?.bostaFeeBreakdown?.total);
  if (Number.isFinite(breakdownTotal) && breakdownTotal > 0) return breakdownTotal;
  const stored = Number(order?.bostaCourierFee);
  if (Number.isFinite(stored) && stored > 0) return stored;
  if (typeof fallbackFn === 'function') {
    const fb = Number(fallbackFn(order)) || 0;
    return fb > 0 ? fb : 0;
  }
  return 0;
}

/**
 * Fee amount only when it came from Bosta APIs (delivery wallet or pricing calculator).
 * Never uses Gazelle city/zone estimates.
 */
export function resolveBostaApiFee(order) {
  const breakdown = order?.bostaFeeBreakdown;
  const total = Number(breakdown?.total);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const src = String(breakdown?.source || '').toLowerCase();
  if (src === 'zone' || src === 'estimate' || src === 'fallback') return 0;
  return total;
}

export function computeShippingEconomics({
  customerShipping = 0,
  bostaFees = 0,
  orderCount = 0,
  delivered = null,
  failedRto = null,
} = {}) {
  const collected = roundMoney(customerShipping);
  const bosta = roundMoney(bostaFees);
  const leftAfterBosta = roundMoney(collected - bosta);
  const shippingResult = leftAfterBosta;
  const shippingLoss = shippingResult < 0 ? roundMoney(-shippingResult) : 0;
  const shippingGain = shippingResult > 0 ? shippingResult : 0;

  return {
    customerShipping: collected,
    bostaFees: bosta,
    leftAfterBosta,
    orderCount: Number(orderCount) || 0,
    shippingResult,
    shippingLoss,
    shippingGain,
    delivered: delivered || {
      count: 0,
      withLiveFee: 0,
      customerShipping: 0,
      bostaFees: 0,
    },
    failedRto: failedRto || {
      count: 0,
      withLiveFee: 0,
      customerShipping: 0,
      bostaFees: 0,
      quotedShipping: 0,
    },
    /** Short lines for UI / brand expenses. */
    summaryLines: [
      {
        key: 'collected',
        label: 'Customer shipping collected',
        amount: collected,
      },
      {
        key: 'bosta_delivered',
        label: 'Bosta fees (delivered)',
        amount: roundMoney(delivered?.bostaFees ?? 0),
      },
      {
        key: 'bosta_failed',
        label: 'Bosta fees (failed / RTO)',
        amount: roundMoney(failedRto?.bostaFees ?? 0),
      },
      {
        key: 'bosta_total',
        label: 'Total Bosta fees (API)',
        amount: bosta,
      },
      {
        key: 'left',
        label: 'Left after Bosta',
        amount: leftAfterBosta,
      },
      {
        key: 'loss',
        label: 'Brand shipping loss',
        amount: shippingLoss,
      },
    ],
  };
}

/**
 * Build shipping economics from order lists.
 * Prefer fees already synced from Bosta APIs onto order.bostaFeeBreakdown.
 */
export function computeShippingEconomicsFromOrders({
  deliveredOrders = [],
  failedRtoOrders = [],
  bostaApiOnly = true,
  fallbackFee,
} = {}) {
  const feeOf = (order) =>
    bostaApiOnly ? resolveBostaApiFee(order) : resolveRealBostaFee(order, fallbackFee);

  let deliveredShip = 0;
  let deliveredBosta = 0;
  let deliveredCount = 0;
  let deliveredWithFee = 0;

  for (const order of deliveredOrders) {
    if (!isBostaShippingOrder(order)) continue;
    const fee = feeOf(order);
    deliveredCount += 1;
    deliveredShip += Number(order.shippingFee) || 0;
    deliveredBosta += fee;
    if (fee > 0) deliveredWithFee += 1;
  }

  let failedBosta = 0;
  let failedCount = 0;
  let failedQuoted = 0;
  let failedWithFee = 0;

  for (const order of failedRtoOrders) {
    if (!isBostaShippingOrder(order)) continue;
    const fee = feeOf(order);
    failedCount += 1;
    failedBosta += fee;
    failedQuoted += Number(order.shippingFee) || 0;
    if (fee > 0) failedWithFee += 1;
  }

  return computeShippingEconomics({
    customerShipping: deliveredShip,
    bostaFees: deliveredBosta + failedBosta,
    orderCount: deliveredCount + failedCount,
    delivered: {
      count: deliveredCount,
      withLiveFee: deliveredWithFee,
      customerShipping: roundMoney(deliveredShip),
      bostaFees: roundMoney(deliveredBosta),
    },
    failedRto: {
      count: failedCount,
      withLiveFee: failedWithFee,
      customerShipping: 0,
      bostaFees: roundMoney(failedBosta),
      quotedShipping: roundMoney(failedQuoted),
    },
  });
}

/**
 * Load delivered + failed/RTO Bosta orders, sync live fees from Bosta APIs, then compute.
 */
export async function loadShippingEconomicsForRange({ from, to, Order, OrderStatusHistory } = {}) {
  if (!shippingLossAppliesToRange({ from, to })) {
    return {
      ...computeShippingEconomics({}),
      enabled: false,
      appliesFrom: SHIPPING_LOSS_START_YMD,
      feeSource: 'bosta_api',
      bostaSync: { attempted: 0, synced: 0, missing: 0, apiConfigured: false },
    };
  }

  const shippingStart = zonedDayBound(SHIPPING_LOSS_START_YMD);
  const rangeFrom = rangeStart(from) || shippingStart;
  const rangeTo = rangeEnd(to) || new Date();
  const fromBound = rangeFrom < shippingStart ? shippingStart : rangeFrom;

  const select =
    'internalStatus deliveredAt updatedAt placedAt shippingFee shippingMethod totalSellingPrice paymentMethod bostaCourierFee bostaFeeBreakdown bostaTrackingNumber bostaDeliveryId shippingAddress';

  const bostaMethodFilter = {
    shippingMethod: { $nin: ['local_shipping', 'pickup'] },
    $or: [
      { shippingMethod: 'bosta' },
      { shippingMethod: null },
      { shippingMethod: { $exists: false } },
      { bostaTrackingNumber: { $exists: true, $nin: [null, ''] } },
      { bostaDeliveryId: { $exists: true, $nin: [null, ''] } },
    ],
  };

  const History =
    OrderStatusHistory || (await import('../models/OrderStatusHistory.js')).default;

  const [deliveredOrders, failedRtoOrders] = await Promise.all([
    Order.find({
      internalStatus: 'delivered',
      deliveredAt: { $gte: fromBound, $lte: rangeTo },
      ...bostaMethodFilter,
    }).select(select),
    findFailedRtoOrdersForRange({
      Order,
      OrderStatusHistory: History,
      fromBound,
      rangeTo,
      extraFilter: bostaMethodFilter,
      select,
    }),
  ]);

  const allOrders = [...deliveredOrders, ...failedRtoOrders];
  let bostaSync = {
    attempted: allOrders.length,
    synced: 0,
    fromDelivery: 0,
    fromCalculator: 0,
    missing: 0,
    apiConfigured: false,
  };

  try {
    const { syncBostaFeesForOrders, isBostaConfigured } = await import(
      '../integrations/bosta/bostaFees.service.js'
    );
    bostaSync.apiConfigured = Boolean(isBostaConfigured());
    if (bostaSync.apiConfigured && allOrders.length) {
      const syncResult = await syncBostaFeesForOrders(allOrders, {
        concurrency: 6,
        force: false,
        allowCalculator: true,
      });
      bostaSync = {
        ...bostaSync,
        synced: syncResult.synced,
        fromDelivery: syncResult.fromDelivery,
        fromCalculator: syncResult.fromCalculator,
        missing: syncResult.missing,
        attempted: syncResult.attempted,
      };
    }
  } catch (err) {
    bostaSync.error = err.message || String(err);
  }

  const economics = computeShippingEconomicsFromOrders({
    deliveredOrders,
    failedRtoOrders,
    bostaApiOnly: true,
  });

  return {
    ...economics,
    enabled: true,
    appliesFrom: SHIPPING_LOSS_START_YMD,
    feeSource: 'bosta_api',
    bostaSync,
  };
}
