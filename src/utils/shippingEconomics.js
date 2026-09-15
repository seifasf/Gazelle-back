/**
 * Shipping economics (from Sep 2026):
 *   Left after Bosta = customer shipping collected - Bosta courier fees
 *   Shipping result  = Left after Bosta - (EGP 25 * Bosta deliveries)
 *   Shipping loss    = max(0, -shipping result)  // brand paid loss on shipping
 *
 * EGP 25 is the OMS per-shipment allowance used in this brand shipping P&L
 * (same figure as the COD policy fee, applied here as a fixed shipping deduction).
 */

export const SHIPPING_LOSS_START_YMD = '2026-09-01';
export const SHIPPING_EGP25_PER_ORDER = 25;

export function shippingLossAppliesToRange({ from, to } = {}) {
  const start = new Date(`${SHIPPING_LOSS_START_YMD}T00:00:00.000Z`);
  const end = to ? new Date(to) : null;
  if (end && String(to).length <= 10) end.setUTCHours(23, 59, 59, 999);
  // Apply when the selected range overlaps Sep 2026+ (or has no end / ends on/after Sep).
  if (end && end < start) return false;
  return true;
}

export function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * @param {object} args
 * @param {number} args.customerShipping - sum of order.shippingFee collected
 * @param {number} args.bostaFees - sum of Bosta courier fees paid by brand
 * @param {number} args.orderCount - delivered Bosta shipments counted
 * @param {boolean} [args.applyEgp25=true]
 */
export function computeShippingEconomics({
  customerShipping = 0,
  bostaFees = 0,
  orderCount = 0,
  applyEgp25 = true,
} = {}) {
  const collected = roundMoney(customerShipping);
  const bosta = roundMoney(bostaFees);
  const leftAfterBosta = roundMoney(collected - bosta);
  const egp25Total = applyEgp25
    ? roundMoney(SHIPPING_EGP25_PER_ORDER * (Number(orderCount) || 0))
    : 0;
  const shippingResult = roundMoney(leftAfterBosta - egp25Total); // Left after Bosta - EGP 25
  const shippingLoss = shippingResult < 0 ? roundMoney(-shippingResult) : 0;
  const shippingGain = shippingResult > 0 ? shippingResult : 0;

  return {
    customerShipping: collected,
    bostaFees: bosta,
    leftAfterBosta,
    egp25PerOrder: applyEgp25 ? SHIPPING_EGP25_PER_ORDER : 0,
    egp25Total,
    orderCount: Number(orderCount) || 0,
    /** Left after Bosta - EGP 25 (can be negative). */
    shippingResult,
    /** Brand paid loss when shippingResult < 0. */
    shippingLoss,
    shippingGain,
  };
}
