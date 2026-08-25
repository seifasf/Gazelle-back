/**
 * Do not write COD EGP 25 or ONLINE5 onto Shopify. Checkout stays as placed.
 */

export const ONLINE_DISCOUNT_CODE = 'ONLINE5';
export const COD_FEE_EGP = 25;
export const COD_FEE_SKU = 'GAZELLE-COD-FEE';
export const COD_FEE_TITLE = 'رسوم الدفع عند الاستلام';
export const INCENTIVE_ATTR = 'gazelle_pay';

const FEE_TITLE_RE =
  /cod fee|cash on delivery fee|releasit|رسوم الدفع عند الاستلام|رسوم الدفع عند الاستلام/i;

function codesOnOrder(payload = {}) {
  const fromCodes = (payload.discount_codes || []).map((c) => String(c.code || '').toUpperCase());
  const fromApps = (payload.discount_applications || []).map((d) =>
    String(d.code || d.title || '').toUpperCase()
  );
  return [...fromCodes, ...fromApps];
}

function extraFeeAmount(payload = {}) {
  const raw =
    payload.current_total_additional_fees_set?.shop_money?.amount ??
    payload.original_total_additional_fees_set?.shop_money?.amount ??
    payload.total_additional_fees_set?.shop_money?.amount;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

export function isCodFeeLine(line = {}) {
  const sku = String(line.sku || line.variant?.sku || '').toUpperCase();
  const title = String(line.title || line.name || '');
  if (sku === COD_FEE_SKU) return true;
  if (title.includes(COD_FEE_TITLE)) return true;
  if (FEE_TITLE_RE.test(title)) return true;
  return false;
}

export function orderHasOnlineDiscount(payload = {}) {
  return codesOnOrder(payload).some((c) => c === ONLINE_DISCOUNT_CODE || c.includes('ONLINE5'));
}

export function orderHasCodFee(payload = {}) {
  if (extraFeeAmount(payload) >= COD_FEE_EGP - 0.5) return true;
  return (payload.line_items || []).some(isCodFeeLine);
}

export function isOnlineFiveDiscount(app = {}) {
  const blob = `${app.code || ''} ${app.title || ''} ${app.description || ''}`.toUpperCase();
  return blob.includes('ONLINE5') || blob.includes('ONLINE 5');
}

/**
 * @param {object} payload Shopify REST order
 * @param {'cod' | 'online'} paymentMethod
 */
export function planPaymentIncentives(_payload, _paymentMethod) {
  return {
    addCodFee: false,
    removeCodFee: false,
    addOnlineDiscount: false,
    removeOnlineDiscount: false,
  };
}

/** Goods total for OMS — strip shipping and any Shopify/Releasit COD fee line. */
export function shopifyMerchandiseTotal(payload = {}, shippingFee = 0) {
  const total = parseFloat(payload.total_price) || 0;
  const feeOnShopify = orderHasCodFee(payload) ? COD_FEE_EGP : 0;
  const ship = Number(shippingFee) || 0;
  return Math.max(0, Math.round((total - ship - feeOnShopify) * 100) / 100);
}

export function incentivesNeedShopifyEdit(plan) {
  if (!plan) return false;
  return Boolean(
    plan.addCodFee || plan.removeCodFee || plan.removeOnlineDiscount || plan.addOnlineDiscount
  );
}
