/**
 * Shipping economics (from Sep 2026) — courier shipping only:
 *   Left after Bosta = customer shipping collected ? Bosta courier fees
 *   Shipping loss    = max(0, ?Left after Bosta)
 *
 * Do NOT apply EGP 25 here. EGP 25 is the COD fee (COD orders only), already
 * collected on cash-on-delivery — it is not a per-shipment shipping charge
 * and must not be multiplied by Bosta delivery count.
 */

export const SHIPPING_LOSS_START_YMD = '2026-09-01';

export function shippingLossAppliesToRange({ from, to } = {}) {
  const start = new Date(`${SHIPPING_LOSS_START_YMD}T00:00:00.000Z`);
  const end = to ? new Date(to) : null;
  if (end && String(to).length <= 10) end.setUTCHours(23, 59, 59, 999);
  if (end && end < start) return false;
  return true;
}

export function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * @param {object} args
 * @param {number} args.customerShipping - sum of order.shippingFee on Bosta deliveries
 * @param {number} args.bostaFees - sum of Bosta courier fees paid by brand
 * @param {number} args.orderCount - delivered Bosta shipments counted
 */
export function computeShippingEconomics({
  customerShipping = 0,
  bostaFees = 0,
  orderCount = 0,
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
  };
}
