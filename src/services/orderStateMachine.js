import { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from '../constants/index.js';

/**
 * Allowed order status transitions.
 * Keys are current status; values are arrays of valid next statuses.
 */
export const ORDER_TRANSITIONS = {
  pending_verification: ['verified_ready_for_shipping', 'cancelled'],
  // Pickup orders can be marked as delivered directly (no courier step).
  verified_ready_for_shipping: ['picked_up_by_bosta', 'delivered', 'cancelled'],
  // Bosta webhooks can skip steps (e.g. exception → RTO without a separate in_transit event).
  picked_up_by_bosta: ['in_transit', 'delivered', 'failed_delivery', 'returning_to_origin'],
  in_transit: ['delivered', 'failed_delivery', 'returning_to_origin'],
  failed_delivery: ['in_transit', 'returning_to_origin', 'delivered'],
  returning_to_origin: ['returned_to_stock'],
  // Customer return / RTO after a successful delivery is handled via Bosta return sync + stock confirm.
  delivered: ['returning_to_origin'],
  returned_to_stock: [],
  cancelled: [],
};

export function canTransition(fromStatus, toStatus) {
  if (!ORDER_STATUSES.includes(toStatus)) return false;
  if (TERMINAL_ORDER_STATUSES.includes(fromStatus)) return false;
  const allowed = ORDER_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

export function isTerminalStatus(status) {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function assertTransition(fromStatus, toStatus) {
  if (!canTransition(fromStatus, toStatus)) {
    const err = new Error(`Invalid transition: ${fromStatus} → ${toStatus}`);
    err.statusCode = 400;
    throw err;
  }
}
