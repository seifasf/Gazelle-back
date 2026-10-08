/** Bosta lookup key for an order, preferring what we already linked over the webhook hint. */
export function bostaLookupKey(order, { deliveryId, payload } = {}) {
  const linkedKey = order?.bostaTrackingNumber || order?.bostaDeliveryId || null;
  const hintedKey = payload?.trackingNumber || deliveryId || null;
  return { key: linkedKey || hintedKey, linked: Boolean(linkedKey) };
}

/**
 * Turn a live Bosta delivery into the update to apply, or null when it must be ignored.
 * When the order had no Bosta link, the delivery must carry the order id as businessReference.
 */
export function pickLiveBostaUpdate({ order, delivery, linked, hintedDeliveryId }) {
  const live = delivery?.data || delivery;
  const state = live?.state || live?.status;
  if (!order || !live || state == null || state === '') return null;

  if (!linked) {
    const ref = String(live.businessReference || live.business_reference || '').trim();
    if (ref !== String(order._id)) return null;
  }

  return {
    deliveryId:
      order.bostaDeliveryId || (live._id != null ? String(live._id) : hintedDeliveryId),
    state,
    payload: live,
  };
}
