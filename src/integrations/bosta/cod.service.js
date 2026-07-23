import { bostaRequest, isBostaConfigured } from './client.js';
import Order from '../../models/Order.js';
import logger from '../../utils/logger.js';
import { getDelivery } from './shipments.service.js';

export { isBostaConfigured };

const PAGE_SIZE = 50;
const MAX_PAGES = 80;
const BUSINESS_TZ = 'Africa/Cairo';
const REFRESH_CONCURRENCY = 8;

function deliveryCod(delivery) {
  if (typeof delivery?.cod === 'number') return delivery.cod;
  return Number(delivery?.cod?.amount ?? delivery?.codAmount ?? 0) || 0;
}

function deliveryCollectedAt(delivery) {
  const raw =
    delivery?.wallet?.cashCycle?.deposited_at ||
    delivery?.wallet?.cashCycle?.depositedAt ||
    delivery?.cashoutInfo?.depositedAt ||
    delivery?.state?.deliveryTime ||
    delivery?.state?.delivering?.time ||
    delivery?.confirmedDeliveryAt ||
    delivery?.updatedAt ||
    delivery?.createdAt;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isDeliveredState(delivery) {
  const code = delivery?.state?.code;
  if (code === 45) return true;
  const label = String(delivery?.state?.value || delivery?.state?.name || '').toLowerCase();
  return label.includes('delivered');
}

/** Calendar YYYY-MM-DD in Africa/Cairo (not UTC). */
function cairoYmd(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date instanceof Date ? date : new Date(date));
}

async function stampOrderFromDelivery(delivery, { from, to } = {}) {
  const collectedAt = deliveryCollectedAt(delivery);
  const cod = deliveryCod(delivery);
  if (!collectedAt || !(cod > 0) || !isDeliveredState(delivery)) return null;
  if (from && collectedAt < from) return null;
  if (to && collectedAt > to) return null;

  const deliveryId = delivery._id || delivery.id;
  const tracking = delivery.trackingNumber != null ? String(delivery.trackingNumber) : null;
  const ref = String(delivery.businessReference || '').trim();
  const or = [];
  if (deliveryId) or.push({ bostaDeliveryId: String(deliveryId) });
  if (tracking) or.push({ bostaTrackingNumber: tracking });
  if (ref && /^[a-f\d]{24}$/i.test(ref)) or.push({ _id: ref });
  if (ref && /^\d+$/.test(ref)) or.push({ shopifyOrderId: ref });
  if (!or.length) return null;

  const result = await Order.updateOne(
    {
      $or: or,
      $and: [
        {
          $or: [
            { paymentMethod: 'cod' },
            { paymentMethod: { $exists: false } },
            { paymentMethod: null },
          ],
        },
      ],
    },
    {
      $set: {
        bostaCollectedAmount: cod,
        bostaCollectedAt: collectedAt,
        ...(deliveryId ? { bostaDeliveryId: String(deliveryId) } : {}),
        ...(tracking ? { bostaTrackingNumber: tracking } : {}),
      },
    }
  );
  if (result.matchedCount > 0) {
    return { deliveryId, tracking, cod, collectedAt };
  }
  return null;
}

async function mapPool(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i;
      i += 1;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * Pull Bosta Delivered COD for Gazelle-linked orders in [from, to].
 * Prefer refreshing OMS candidates (accurate) over paging the whole Bosta account.
 */
export async function syncAndSumDeliveredCod({ from, to, maxPages = MAX_PAGES } = {}) {
  if (!isBostaConfigured()) {
    return { amount: 0, count: 0, source: 'unavailable', real: false };
  }

  const startYmd = cairoYmd(from);
  const endYmd = cairoYmd(to);
  const stamped = [];
  let fetched = 0;
  let pages = 0;
  let refreshed = 0;

  const candidates = await Order.find({
    $or: [{ paymentMethod: 'cod' }, { paymentMethod: { $exists: false } }, { paymentMethod: null }],
    $and: [
      {
        $or: [
          { deliveredAt: { $gte: from, $lte: to } },
          { bostaCollectedAt: { $gte: from, $lte: to } },
          {
            internalStatus: { $in: ['delivered', 'picked_up_by_bosta', 'in_transit'] },
            lastStatusUpdateAt: { $gte: from, $lte: to },
          },
        ],
      },
      {
        $or: [
          { bostaDeliveryId: { $exists: true, $nin: [null, ''] } },
          { bostaTrackingNumber: { $exists: true, $nin: [null, ''] } },
        ],
      },
    ],
  })
    .select('_id bostaDeliveryId bostaTrackingNumber')
    .lean();

  const knownIds = new Set(
    candidates.flatMap((o) => [o.bostaDeliveryId, o.bostaTrackingNumber].filter(Boolean).map(String))
  );

  await mapPool(candidates, REFRESH_CONCURRENCY, async (order) => {
    const key = order.bostaTrackingNumber || order.bostaDeliveryId;
    if (!key) return;
    try {
      const delivery = await getDelivery(key);
      refreshed += 1;
      const hit = await stampOrderFromDelivery(delivery, { from, to });
      if (hit) stamped.push(hit);
    } catch {
      /* skip missing */
    }
  });

  // Supplemental search: only stamp deliveries that match known Gazelle ids or mongo refs.
  for (let page = 0; page < maxPages; page += 1) {
    pages += 1;
    let list = [];
    try {
      const response = await bostaRequest('/deliveries/search', {
        method: 'POST',
        body: {
          page,
          limit: PAGE_SIZE,
          state: 'Delivered',
          startDate: startYmd,
          endDate: endYmd,
        },
      });
      list = response?.data?.deliveries || response?.deliveries || [];
    } catch (err) {
      logger.warn({ err, page }, 'Bosta COD search page failed');
      break;
    }
    if (!list.length) break;
    fetched += list.length;

    for (const delivery of list) {
      const deliveryId = delivery._id || delivery.id;
      const tracking = delivery.trackingNumber != null ? String(delivery.trackingNumber) : null;
      const ref = String(delivery.businessReference || '').trim();
      const looksGazelle =
        (deliveryId && knownIds.has(String(deliveryId))) ||
        (tracking && knownIds.has(tracking)) ||
        /^[a-f\d]{24}$/i.test(ref);
      if (!looksGazelle) continue;
      const hit = await stampOrderFromDelivery(delivery, { from, to });
      if (hit) stamped.push(hit);
    }

    if (list.length < PAGE_SIZE) break;
  }

  const [row] = await Order.aggregate([
    {
      $match: {
        $or: [{ paymentMethod: 'cod' }, { paymentMethod: { $exists: false } }, { paymentMethod: null }],
        bostaCollectedAt: { $gte: from, $lte: to },
        bostaCollectedAmount: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: null,
        amount: { $sum: '$bostaCollectedAmount' },
        count: { $sum: 1 },
      },
    },
  ]);

  const result = {
    amount: row?.amount ?? 0,
    count: row?.count ?? 0,
    source: 'bosta',
    real: true,
    pages,
    fetched,
    refreshed,
    stamped: stamped.length,
    candidates: candidates.length,
    startYmd,
    endYmd,
  };
  logger.info(result, 'Bosta COD sync-and-sum finished');
  return result;
}

/** @deprecated Prefer syncAndSumDeliveredCod — kept for callers. */
export async function sumDeliveredCod(opts) {
  return syncAndSumDeliveredCod(opts);
}

export default { sumDeliveredCod, syncAndSumDeliveredCod, isBostaConfigured };
