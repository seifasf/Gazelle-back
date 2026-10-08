export const FINANCIAL_FIELDS = new Set(['cogs', 'unitCogs', 'totalCogsSnapshot']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function strip(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;

  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((item) => strip(item, seen));
  }
  if (typeof value.toObject === 'function' && !isPlainObject(value)) {
    return strip(value.toObject(), seen);
  }
  if (!isPlainObject(value)) return value;

  seen.add(value);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (FINANCIAL_FIELDS.has(key)) continue;
    out[key] = strip(child, seen);
  }
  return out;
}

/** Remove cost fields at any depth (orders lists, populated variants, nested payloads) for non-admins. */
export function stripFinancialFields(obj, role) {
  if (role === 'admin' || !obj) return obj;
  return strip(obj, new WeakSet());
}

export default stripFinancialFields;
