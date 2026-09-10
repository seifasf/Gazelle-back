/**
 * Money owed back to the customer for a return / exchange-with-credit.
 * Prefer stored refundAmount, then collect line prices, then linked prior order lines.
 */
export function computeCustomerRefundAmount(order, priorOrder = null) {
  const stored = Number(order?.refundAmount);
  if (Number.isFinite(stored) && stored > 0) return Math.round(stored * 100) / 100;

  if (order?.isExchangeOrder) {
    const credit = Number(order.exchangeCreditAmount) || 0;
    if (credit > 0) return Math.round(credit * 100) / 100;
  }

  const collect = Array.isArray(order?.bostaReturnItems) && order.bostaReturnItems.length
    ? order.bostaReturnItems
    : order?.isReturnOrder
      ? order.items || []
      : [];

  let fromCollect = 0;
  for (const line of collect) {
    const unit = Number(line.unitSellingPrice);
    if (Number.isFinite(unit) && unit > 0) {
      fromCollect += unit * (Number(line.quantity) || 1);
    }
  }
  if (fromCollect > 0) return Math.round(fromCollect * 100) / 100;

  if (priorOrder) {
    const returnVariantIds = new Set(
      collect.map((i) => String(i.variantId?._id || i.variantId || '')).filter(Boolean)
    );
    const returnSkus = new Set(
      collect.map((i) => String(i.sku || '').toUpperCase()).filter(Boolean)
    );
    let fromPrior = 0;
    for (const pi of priorOrder.items || []) {
      const vid = String(pi.variantId?._id || pi.variantId || '');
      const sku = String(pi.sku || '').toUpperCase();
      const match =
        (vid && returnVariantIds.has(vid)) ||
        (sku && returnSkus.has(sku)) ||
        returnVariantIds.size === 0;
      if (!match) continue;
      fromPrior += (Number(pi.unitSellingPrice) || 0) * (Number(pi.quantity) || 1);
    }
    if (fromPrior > 0) return Math.round(fromPrior * 100) / 100;
    const priorTotal = Number(priorOrder.totalSellingPrice) || 0;
    if (priorTotal > 0) return Math.round(priorTotal * 100) / 100;
  }

  return 0;
}
