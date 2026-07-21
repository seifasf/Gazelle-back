import { bostaRequest, isBostaConfigured } from './client.js';
import Order from '../../models/Order.js';
import logger from '../../utils/logger.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 60;

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

function ymd(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * Pull Bosta Delivered deliveries in [from, to], stamp COD onto matching OMS orders,
 * then return the OMS-linked aggregate (Gazelle only — not whole Bosta account).
 */
export async function syncAndSumDeliveredCod({ from, to, maxPages = MAX_PAGES } = {}) {
  if (!isBostaConfigured()) {
    return { amount: 0, count: 0, source: 'unavailable', real: false };
  }

  const startYmd = ymd(from);
  const endYmd = ymd(to);
  const stamped = [];
  let pages = 0;
  let fetched = 0;

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
      const collectedAt = deliveryCollectedAt(delivery);
      if (!collectedAt || collectedAt < from || collectedAt > to) continue;
      const cod = deliveryCod(delivery);
      if (!(cod > 0)) continue;

      const deliveryId = delivery._id || delivery.id;
      const tracking = delivery.trackingNumber != null ? String(delivery.trackingNumber) : null;
      const ref = String(delivery.businessReference || '').trim();
      const or = [];
      if (deliveryId) or.push({ bostaDeliveryId: String(deliveryId) });
      if (tracking) or.push({ bostaTrackingNumber: tracking });
      if (ref && /^[a-f\d]{24}$/i.test(ref)) or.push({ _id: ref });
      if (ref && /^\d+$/.test(ref)) or.push({ shopifyOrderId: ref });
      if (!or.length) continue;

      const result = await Order.updateOne(
        { $or: or },
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
        stamped.push({ deliveryId, tracking, cod, collectedAt });
      }
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
    stamped: stamped.length,
  };
  logger.info(result, 'Bosta COD sync-and-sum finished');
  return result;
}

/** @deprecated Prefer syncAndSumDeliveredCod — kept for callers. */
export async function sumDeliveredCod(opts) {
  return syncAndSumDeliveredCod(opts);
}

export default { sumDeliveredCod, syncAndSumDeliveredCod };
