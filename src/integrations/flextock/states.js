/**
 * Flextock order_status strings (PDF sample: "canceled").
 * Unknown live values are kept on the order; we only map common ones.
 */

export const FLEXTOCK_INTERNAL = {
  awaiting: 'awaiting_bosta_pickup',
  picked: 'picked_up_by_bosta',
  transit: 'in_transit',
  delivered: 'delivered',
  failed: 'failed_delivery',
  returning: 'returning_to_origin',
  returned: 'returned_awaiting_receipt',
};

function compact(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

const MAP = {
  pending: FLEXTOCK_INTERNAL.awaiting,
  created: FLEXTOCK_INTERNAL.awaiting,
  new: FLEXTOCK_INTERNAL.awaiting,
  received: FLEXTOCK_INTERNAL.awaiting,
  processing: FLEXTOCK_INTERNAL.awaiting,
  picking: FLEXTOCK_INTERNAL.awaiting,
  packing: FLEXTOCK_INTERNAL.awaiting,
  fulfilling: FLEXTOCK_INTERNAL.awaiting,
  confirmed: FLEXTOCK_INTERNAL.awaiting,
  fulfilled: FLEXTOCK_INTERNAL.picked,
  shipped: FLEXTOCK_INTERNAL.picked,
  dispatched: FLEXTOCK_INTERNAL.picked,
  picked: FLEXTOCK_INTERNAL.picked,
  picked_up: FLEXTOCK_INTERNAL.picked,
  in_transit: FLEXTOCK_INTERNAL.transit,
  out_for_delivery: FLEXTOCK_INTERNAL.transit,
  on_the_way: FLEXTOCK_INTERNAL.transit,
  delivered: FLEXTOCK_INTERNAL.delivered,
  completed: FLEXTOCK_INTERNAL.delivered,
  canceled: FLEXTOCK_INTERNAL.returned,
  cancelled: FLEXTOCK_INTERNAL.returned,
  failed: FLEXTOCK_INTERNAL.failed,
  exception: FLEXTOCK_INTERNAL.failed,
  undelivered: FLEXTOCK_INTERNAL.failed,
  returned: FLEXTOCK_INTERNAL.returned,
  rto: FLEXTOCK_INTERNAL.returning,
  returning: FLEXTOCK_INTERNAL.returning,
  returning_to_origin: FLEXTOCK_INTERNAL.returning,
};

export function normalizeFlextockStatus(raw) {
  return compact(raw);
}

export function mapFlextockStatusToInternal(raw) {
  const key = normalizeFlextockStatus(raw);
  return MAP[key] || null;
}

export default { FLEXTOCK_INTERNAL, normalizeFlextockStatus, mapFlextockStatusToInternal };
