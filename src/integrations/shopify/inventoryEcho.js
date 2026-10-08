/**
 * Telling our own OMS ? Shopify inventory pushes apart from real Shopify-side changes.
 *
 * Every push records `{ qty, at }` in a short per-variant history plus `lastShopifyPushAt`.
 * An inventory_levels/update webhook is:
 *   - stale: its `updated_at` is not newer than our last push (our absolute set already superseded it);
 *   - echo:  its quantity equals any value we pushed within the echo window (echoes can arrive out of order).
 */
export const SHOPIFY_PUSH_HISTORY_MAX = 10;
export const SHOPIFY_INVENTORY_ECHO_MS = 3 * 60_000;

/** Mongo update fragments recording one push of `qty` to Shopify. */
export function pushRecordUpdate(qty, at = new Date()) {
  return {
    $set: { lastShopifyPushAt: at },
    $push: {
      shopifyPushHistory: { $each: [{ qty, at }], $slice: -SHOPIFY_PUSH_HISTORY_MAX },
    },
  };
}

function toMs(value) {
  if (value == null || value === '') return NaN;
  return new Date(value).getTime();
}

/** @returns {'stale' | 'echo' | null} */
export function classifyInboundInventory({
  targetAvail,
  lastPushAt,
  pushHistory,
  eventAt,
  now = Date.now(),
  echoMs = SHOPIFY_INVENTORY_ECHO_MS,
}) {
  const pushMs = toMs(lastPushAt);
  const eventMs = toMs(eventAt);
  if (Number.isFinite(pushMs) && Number.isFinite(eventMs) && eventMs <= pushMs) return 'stale';

  for (const entry of pushHistory || []) {
    const at = toMs(entry?.at);
    if (Number(entry?.qty) === targetAvail && Number.isFinite(at) && now - at < echoMs) return 'echo';
  }
  return null;
}
