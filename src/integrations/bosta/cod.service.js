import { bostaRequest, isBostaConfigured } from './client.js';
import Order from '../../models/Order.js';
import logger from '../../utils/logger.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 80;

function deliveryCod(delivery) {
  if (typeof delivery?.cod === 'number') return delivery.cod;
  return Number(delivery?.cod?.amount ?? delivery?.codAmount ?? 0) || 0;
}

function deliveryCollectedAt(delivery) {
  const raw =
    delivery?.state?.deliveryTime ||
    delivery?.state?.delivering?.time ||
    delivery?.updatedAt ||
    delivery?.createdAt;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Sum COD on Bosta Delivered deliveries whose delivery time falls in [from, to].
 * Account-wide (same as Bosta returns) — not limited to OMS-linked orders.
 */
export async function sumDeliveredCod({ from, to, maxPages = MAX_PAGES } = {}) {
  if (!isBostaConfigured()) {
    const err = new Error('Bosta API key not configured');
    err.statusCode = 400;
    throw err;
  }

  let amount = 0;
  let count = 0;
  let pages = 0;
  let emptyDatePages = 0;
  const backfill = [];

  for (let page = 0; page < maxPages; page += 1) {
    pages += 1;
    const response = await bostaRequest('/deliveries/search', {
      method: 'POST',
      body: { page, limit: PAGE_SIZE, state: 'Delivered' },
    });
    const list = response?.data?.deliveries || response?.deliveries || [];
    if (!list.length) break;

    let inDateWindow = 0;
    for (const delivery of list) {
      const collectedAt = deliveryCollectedAt(delivery);
      if (!collectedAt) continue;
      if (collectedAt < from || collectedAt > to) continue;
      inDateWindow += 1;

      const cod = deliveryCod(delivery);
      if (!(cod > 0)) continue;

      amount += cod;
      count += 1;

      const deliveryId = delivery._id || delivery.id;
      const tracking = delivery.trackingNumber != null ? String(delivery.trackingNumber) : null;
      if (deliveryId || tracking) {
        backfill.push({ deliveryId, tracking, cod, collectedAt });
      }
    }

    if (inDateWindow === 0) emptyDatePages += 1;
    else emptyDatePages = 0;

    // After a few consecutive pages with no deliveries in the selected window, stop.
    if (emptyDatePages >= 5 && pages >= 8) break;
    if (list.length < PAGE_SIZE) break;
  }

  if (backfill.length) {
    Promise.resolve()
      .then(async () => {
        for (const row of backfill.slice(0, 500)) {
          const match = [];
          if (row.deliveryId) match.push({ bostaDeliveryId: String(row.deliveryId) });
          if (row.tracking) match.push({ bostaTrackingNumber: row.tracking });
          if (!match.length) continue;
          await Order.updateOne(
            {
              $and: [
                { $or: match },
                {
                  $or: [
                    { bostaCollectedAmount: { $exists: false } },
                    { bostaCollectedAmount: null },
                    { bostaCollectedAmount: 0 },
                  ],
                },
              ],
            },
            {
              $set: {
                bostaCollectedAmount: row.cod,
                bostaCollectedAt: row.collectedAt,
              },
            }
          );
        }
      })
      .catch((err) => logger.warn({ err }, 'Bosta COD order backfill failed'));
  }

  return { amount, count, source: 'bosta_api', pages };
}

export default { sumDeliveredCod };
