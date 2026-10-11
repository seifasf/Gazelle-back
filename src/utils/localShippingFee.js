import { LOCAL_SHIPPING_FEE } from '../constants/index.js';

/** Staff-typed shipping fee: a non-negative amount rounded to piasters, or null when blank/invalid. */
export function parseStaffShippingFee(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const fee = Number(raw);
  if (!Number.isFinite(fee) || fee < 0) return null;
  return Math.round(fee * 100) / 100;
}

/** Local courier fee: staff may set any non-negative amount; blank/invalid falls back to the default. */
export function resolveLocalShippingFee(raw) {
  return parseStaffShippingFee(raw) ?? LOCAL_SHIPPING_FEE;
}
