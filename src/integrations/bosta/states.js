/**
 * Bosta delivery state codes (webhook + /deliveries/search).
 * Note: state.value is often a dashboard label ("Delivered") even when code is 46 (returned to business).
 * Always prefer numeric `code` for mapping.
 */

export const BOSTA_STATE = {
  PICKUP_REQUESTED: 10,
  WAITING_FOR_ROUTE: 11,
  ROUTE_ASSIGNED: 20,
  PICKED_UP_FROM_BUSINESS: 21,
  PICKING_UP_FROM_CONSIGNEE: 22,
  PICKED_UP_FROM_CONSIGNEE: 23,
  RECEIVED_AT_WAREHOUSE: 24,
  FULFILLED: 25,
  IN_TRANSIT_BETWEEN_HUBS: 30,
  PICKING_UP_CASH: 40,
  PICKED_UP: 41,
  DELIVERED: 45,
  RETURNED_TO_BUSINESS: 46,
  EXCEPTION: 47,
  TERMINATED: 48,
  CANCELED: 49,
  RETURNED_TO_STOCK: 60,
  LOST: 100,
  DAMAGED: 101,
  INVESTIGATION: 102,
  AWAITING_YOUR_ACTION: 103,
  ARCHIVED: 104,
  ON_HOLD: 105,
};

/** Built-in fallback when DB BostaStatusMapping has no row. */
export const DEFAULT_STATE_TO_INTERNAL = {
  [BOSTA_STATE.PICKUP_REQUESTED]: 'picked_up_by_bosta',
  [BOSTA_STATE.WAITING_FOR_ROUTE]: 'picked_up_by_bosta',
  [BOSTA_STATE.ROUTE_ASSIGNED]: 'picked_up_by_bosta',
  [BOSTA_STATE.PICKED_UP_FROM_BUSINESS]: 'picked_up_by_bosta',
  [BOSTA_STATE.PICKING_UP_FROM_CONSIGNEE]: 'in_transit',
  [BOSTA_STATE.PICKED_UP_FROM_CONSIGNEE]: 'picked_up_by_bosta',
  [BOSTA_STATE.RECEIVED_AT_WAREHOUSE]: 'in_transit',
  [BOSTA_STATE.FULFILLED]: 'in_transit',
  [BOSTA_STATE.IN_TRANSIT_BETWEEN_HUBS]: 'in_transit',
  [BOSTA_STATE.PICKING_UP_CASH]: 'in_transit',
  [BOSTA_STATE.PICKED_UP]: 'picked_up_by_bosta',
  [BOSTA_STATE.DELIVERED]: 'delivered',
  [BOSTA_STATE.RETURNED_TO_BUSINESS]: 'returning_to_origin',
  [BOSTA_STATE.EXCEPTION]: 'failed_delivery',
  [BOSTA_STATE.TERMINATED]: 'returning_to_origin',
  [BOSTA_STATE.CANCELED]: 'returning_to_origin',
  [BOSTA_STATE.RETURNED_TO_STOCK]: 'returning_to_origin',
  [BOSTA_STATE.AWAITING_YOUR_ACTION]: 'returning_to_origin',
  [BOSTA_STATE.LOST]: 'failed_delivery',
  [BOSTA_STATE.DAMAGED]: 'failed_delivery',
  [BOSTA_STATE.ON_HOLD]: 'failed_delivery',
  // String aliases (legacy seed + webhook variants)
  PICKED_UP: 'picked_up_by_bosta',
  IN_TRANSIT: 'in_transit',
  DELIVERED: 'delivered',
  FAILED: 'failed_delivery',
  RETURNED: 'returning_to_origin',
  RETURNED_TO_BUSINESS: 'returning_to_origin',
  TERMINATED: 'returning_to_origin',
  EXCEPTION: 'failed_delivery',
  'Returned to business': 'returning_to_origin',
  Terminated: 'returning_to_origin',
  Delivered: 'delivered',
  'In transit': 'in_transit',
  'Picked up': 'picked_up_by_bosta',
};

export const RETURN_STATE_CODES = new Set([
  BOSTA_STATE.RETURNED_TO_BUSINESS,
  BOSTA_STATE.TERMINATED,
  BOSTA_STATE.RETURNED_TO_STOCK,
  BOSTA_STATE.AWAITING_YOUR_ACTION,
]);

export const RETURN_SEARCH_STATES = ['Returned to business', 'Terminated'];

export function parseBostaDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Normalize webhook/API `state` into lookup tokens (code string + label).
 */
export function extractBostaStateTokens(state) {
  if (state == null || state === '') return [];

  if (typeof state === 'number' && Number.isFinite(state)) {
    return [String(state)];
  }

  if (typeof state === 'string') {
    const trimmed = state.trim();
    const tokens = [trimmed];
    if (/^\d+$/.test(trimmed)) tokens.push(trimmed);
    return tokens;
  }

  if (typeof state === 'object') {
    const tokens = [];
    const code = state.code ?? state.state ?? state.id;
    if (code != null && code !== '') tokens.push(String(code));
    const label = state.value ?? state.name ?? state.label ?? state.state;
    if (label != null && String(label).trim()) tokens.push(String(label).trim());
    return tokens;
  }

  return [String(state)];
}

export function extractBostaStateCode(state) {
  const tokens = extractBostaStateTokens(state);
  for (const t of tokens) {
    if (/^\d+$/.test(t)) return Number(t);
  }
  return null;
}

export function isReturnState(state) {
  const code = extractBostaStateCode(state);
  if (code != null && RETURN_STATE_CODES.has(code)) return true;
  const tokens = extractBostaStateTokens(state).map((t) => t.toLowerCase());
  return tokens.some((t) =>
    t.includes('returned to business') ||
    t === 'terminated' ||
    t === 'returned' ||
    t === 'returned_to_business'
  );
}

/** Best timestamp for when the package became a return. */
export function extractBostaReturnedAt(delivery) {
  const state = delivery?.state;
  return (
    parseBostaDate(state?.returnedToBusiness) ||
    parseBostaDate(state?.terminated) ||
    parseBostaDate(state?.deliveryTime) ||
    parseBostaDate(delivery?.updatedAt) ||
    parseBostaDate(delivery?.createdAt)
  );
}

export function defaultInternalStatusForState(state) {
  const tokens = extractBostaStateTokens(state);
  for (const token of tokens) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_STATE_TO_INTERNAL, token)) {
      return DEFAULT_STATE_TO_INTERNAL[token];
    }
    const upper = token.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(DEFAULT_STATE_TO_INTERNAL, upper)) {
      return DEFAULT_STATE_TO_INTERNAL[upper];
    }
  }
  const code = extractBostaStateCode(state);
  if (code != null && Object.prototype.hasOwnProperty.call(DEFAULT_STATE_TO_INTERNAL, code)) {
    return DEFAULT_STATE_TO_INTERNAL[code];
  }
  return null;
}

export default {
  BOSTA_STATE,
  DEFAULT_STATE_TO_INTERNAL,
  RETURN_STATE_CODES,
  RETURN_SEARCH_STATES,
  extractBostaStateTokens,
  extractBostaStateCode,
  isReturnState,
  extractBostaReturnedAt,
  defaultInternalStatusForState,
  parseBostaDate,
};
