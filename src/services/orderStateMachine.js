import { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from '../constants/index.js';

/**
 * Allowed order status transitions.
 * Keys are current status; values are arrays of valid next statuses.
 */
export const ORDER_TRANSITIONS = {
  pending_verification: ['verified_ready_for_shipping', 'no_response', 'cancelled'],
  // Customer did not answer — can retry call, confirm later, or cancel.
  no_response: ['pending_verification', 'verified_ready_for_shipping', 'cancelled'],
  // Pickup orders can be marked as delivered directly (no courier step).
  // Warehouse can park an order as out_of_stock until inventory is fixed.
  // Bosta: print AWB → awaiting_bosta_pickup; local courier → local_shipping.
  verified_ready_for_shipping: [
    'awaiting_bosta_pickup',
    'local_shipping',
    'picked_up_by_bosta',
    'delivered',
    'out_of_stock',
    'cancelled',
  ],
  // Hold for missing SKUs — edit items, cancel, or send back to Ready to ship.
  out_of_stock: ['verified_ready_for_shipping', 'cancelled'],
  // AWB created on Bosta — courier has not collected yet.
  // Warehouse can pull back to Ready / OOS / Pending if something is wrong.
  awaiting_bosta_pickup: [
    'picked_up_by_bosta',
    'in_transit',
    'delivered',
    'failed_delivery',
    'returning_to_origin',
    'verified_ready_for_shipping',
    'out_of_stock',
    'pending_verification',
    'cancelled',
  ],
  // Local courier has the package — confirm delivery, cancel, fail→stock, or pull back to Pending.
  local_shipping: [
    'delivered',
    'cancelled',
    'pending_verification',
    'in_transit',
    'failed_delivery',
    'returning_to_origin',
    'returned_to_stock',
  ],
  // Bosta webhooks can skip steps (e.g. exception → RTO without a separate in_transit event).
  picked_up_by_bosta: ['in_transit', 'delivered', 'failed_delivery', 'returning_to_origin'],
  in_transit: ['delivered', 'failed_delivery', 'returning_to_origin'],
  // Local failed delivery can go straight back to warehouse stock (courier returns the bag).
  failed_delivery: ['in_transit', 'returning_to_origin', 'delivered', 'returned_to_stock'],
  // Warehouse can confirm receipt even if Bosta never flipped to "Back at Bosta".
  returning_to_origin: ['returned_awaiting_receipt', 'returned_to_stock'],
  returned_awaiting_receipt: ['returned_to_stock'],
  // Customer return / RTO after a successful delivery is handled via Bosta return sync + stock confirm.
  delivered: ['returning_to_origin', 'returned_awaiting_receipt'],
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
