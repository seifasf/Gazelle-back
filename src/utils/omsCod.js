/** OMS-only COD fee. Not written to Shopify. */

export const OMS_COD_FEE_EGP = 25;

export function isOrderPrepaid(order) {
  if (!order) return false;
  const method = String(order.paymentMethod || '').toLowerCase();
  if (method === 'online' || method === 'prepaid') return true;
  const status = String(order.onlinePaymentStatus || '').toLowerCase();
  if (status === 'paid' || status === 'success' || status === 'captured') return true;
  if (order.onlinePaidAt) return true;
  return false;
}

/** Extra EGP 25 on Gazelle COD (policy + Bosta). Never on prepaid, return, or exchange. */
export function omsCodFeeEgp(order) {
  if (!order) return 0;
  if (order.isReturnOrder || order.isExchangeOrder) return 0;
  if (isOrderPrepaid(order)) return 0;
  if (order.isCreatorOrder && !(Number(order.totalSellingPrice) > 0)) return 0;
  return OMS_COD_FEE_EGP;
}

export function omsCodCollectAmount(order) {
  if (!order) return 0;
  if (order.isReturnOrder || isOrderPrepaid(order)) return 0;
  const goods = Number(order.totalSellingPrice) || 0;
  const ship = Number(order.shippingFee) || 0;
  const credit = order.isExchangeOrder ? Number(order.exchangeCreditAmount) || 0 : 0;
  const fee = omsCodFeeEgp(order);
  return Math.max(0, Math.round((goods + ship - credit + fee) * 100) / 100);
}

/** Attach OMS-only COD fee fields for API responses (never stored on Shopify). */
export function enrichOrderMoneyFields(order) {
  const data =
    order && typeof order.toObject === 'function'
      ? order.toObject({ virtuals: true })
      : { ...order };
  data.codFeeEgp = omsCodFeeEgp(data);
  data.codCollectAmount = omsCodCollectAmount(data);
  return data;
}
