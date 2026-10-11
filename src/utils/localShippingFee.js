import { LOCAL_SHIPPING_FEE } from '../constants/index.js';

/** Local courier fee: staff may set any non-negative amount; blank/invalid falls back to the default. */
export function resolveLocalShippingFee(raw) {
  if (raw == null || String(raw).trim() === '') return LOCAL_SHIPPING_FEE;
  const fee = Number(raw);
  if (!Number.isFinite(fee) || fee < 0) return LOCAL_SHIPPING_FEE;
  return Math.round(fee * 100) / 100;
}
