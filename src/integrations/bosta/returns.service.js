import { bostaRequest } from './client.js';
import {
  RETURN_SEARCH_STATES,
  extractBostaStateCode,
  extractBostaReturnedAt,
  parseBostaDate,
  isReturnState,
} from './states.js';
import BostaReturn from '../../models/BostaReturn.js';
import Order from '../../models/Order.js';
import logger from '../../utils/logger.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 80;

async function searchDeliveries(body, { maxPages = MAX_PAGES } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page += 1) {
    const response = await bostaRequest('/deliveries/search', {
      method: 'POST',
      body: { ...body, page, limit: PAGE_SIZE },
    });
    const list = response?.data?.deliveries || response?.deliveries || [];
    if (!list.length) break;
    all.push(...list);
    if (list.length < PAGE_SIZE) break;
  }
  return all;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('20') && digits.length >= 12) return digits.slice(-10);
  if (digits.startsWith('0') && digits.length >= 11) return digits.slice(1);
  return digits.slice(-10);
}

function deliveryTypeMeta(delivery) {
  const type = delivery?.type;
  if (type && typeof type === 'object') {
    return { typeCode: type.code ?? null, typeValue: type.value || type.name || null };
  }
  if (typeof type === 'number') return { typeCode: type, typeValue: null };
  if (typeof type === 'string') return { typeCode: null, typeValue: type };
  return { typeCode: null, typeValue: null };
}

function receiverMeta(delivery) {
  const receiver = delivery?.receiver || {};
  const first = receiver.firstName || '';
  const last = receiver.lastName || '';
  const name = [first, last].filter(Boolean).join(' ').trim() || null;
  return {
    receiverPhone: receiver.phone || null,
    receiverName: name,
  };
}

async function findLinkedOrder(delivery) {
  const tracking = delivery?.trackingNumber != null ? String(delivery.trackingNumber) : null;
  const deliveryId = delivery?._id || delivery?.id;
  const ref = String(delivery?.businessReference || '').trim();

  if (deliveryId) {
    const byId = await Order.findOne({ bostaDeliveryId: String(deliveryId) }).select('_id').lean();
    if (byId) return byId._id;
  }
  if (tracking) {
    const byTracking = await Order.findOne({ bostaTrackingNumber: tracking }).select('_id').lean();
    if (byTracking) return byTracking._id;
  }
  if (ref && /^[a-f\d]{24}$/i.test(ref)) {
    const byRef = await Order.findById(ref).select('_id').lean();
    if (byRef) return byRef._id;
  }
  if (ref && /^\d+$/.test(ref)) {
    const byShopify = await Order.findOne({ shopifyOrderId: ref }).select('_id').lean();
    if (byShopify) return byShopify._id;
  }

  // Phone fuzzy-match is intentionally skipped during bulk sync (too slow / ambiguous).
  return null;
}

function upsertDocFromDelivery(delivery, orderId) {
  const returnedAt = extractBostaReturnedAt(delivery);
  if (!returnedAt) return null;

  const stateCode = extractBostaStateCode(delivery.state);
  if (!isReturnState(delivery.state) && stateCode !== 46 && stateCode !== 48 && stateCode !== 60) {
    // Still allow RTO / customer-return types that may be mid-flight with return timestamps
    const typeCode = delivery?.type?.code;
    if (![20, 25].includes(typeCode)) return null;
  }

  const { typeCode, typeValue } = deliveryTypeMeta(delivery);
  const { receiverPhone, receiverName } = receiverMeta(delivery);
  const cod =
    typeof delivery.cod === 'number'
      ? delivery.cod
      : Number(delivery.cod?.amount ?? delivery.codAmount ?? 0) || 0;

  return {
    bostaDeliveryId: String(delivery._id || delivery.id),
    trackingNumber: delivery.trackingNumber != null ? String(delivery.trackingNumber) : null,
    businessReference: String(delivery.businessReference || '').trim() || null,
    typeCode,
    typeValue,
    stateCode,
    stateValue: delivery?.state?.value || delivery?.state?.name || null,
    returnedAt,
    codAmount: cod,
    receiverPhone,
    receiverName,
    orderId: orderId || null,
    lastSyncedAt: new Date(),
  };
}

/**
 * Pull return deliveries from Bosta and upsert into BostaReturn.
 * When `from`/`to` are set, keep only returns whose returnedAt falls in that window
 * (and stop paging early once pages fall outside the range).
 */
export async function syncBostaReturns({ maxPages = MAX_PAGES, from = null, to = null } = {}) {
  const byId = new Map();
  const inRange = (delivery) => {
    if (!from && !to) return true;
    const at = extractBostaReturnedAt(delivery);
    if (!at) return false;
    if (from && at < from) return false;
    if (to && at > to) return false;
    return true;
  };

  for (const state of RETURN_SEARCH_STATES) {
    const list = await searchDeliveries({ state }, { maxPages });
    for (const d of list) {
      if (inRange(d) || (!from && !to)) byId.set(String(d._id || d.id), d);
    }
  }

  try {
    const rto = await searchDeliveries({ type: 'RTO' }, { maxPages: Math.min(20, maxPages) });
    for (const d of rto) {
      if (!(isReturnState(d.state) || extractBostaReturnedAt(d))) continue;
      if (inRange(d) || (!from && !to)) byId.set(String(d._id || d.id), d);
    }
  } catch (err) {
    logger.warn({ err }, 'Bosta RTO type search failed');
  }

  const deliveries = [...byId.values()];
  const deliveryIds = deliveries.map((d) => String(d._id || d.id));
  const trackings = deliveries
    .map((d) => (d.trackingNumber != null ? String(d.trackingNumber) : null))
    .filter(Boolean);
  const objectRefs = deliveries
    .map((d) => String(d.businessReference || '').trim())
    .filter((r) => /^[a-f\d]{24}$/i.test(r));
  const numericRefs = deliveries
    .map((d) => String(d.businessReference || '').trim())
    .filter((r) => /^\d+$/.test(r));

  const linkedOrders = await Order.find({
    $or: [
      { bostaDeliveryId: { $in: deliveryIds } },
      ...(trackings.length ? [{ bostaTrackingNumber: { $in: trackings } }] : []),
      ...(objectRefs.length ? [{ _id: { $in: objectRefs } }] : []),
      ...(numericRefs.length ? [{ shopifyOrderId: { $in: numericRefs } }] : []),
    ],
  })
    .select('_id bostaDeliveryId bostaTrackingNumber shopifyOrderId')
    .lean();

  const byDeliveryId = new Map();
  const byTracking = new Map();
  const byOrderId = new Map();
  const byShopify = new Map();
  for (const o of linkedOrders) {
    if (o.bostaDeliveryId) byDeliveryId.set(String(o.bostaDeliveryId), o._id);
    if (o.bostaTrackingNumber) byTracking.set(String(o.bostaTrackingNumber), o._id);
    byOrderId.set(String(o._id), o._id);
    if (o.shopifyOrderId) byShopify.set(String(o.shopifyOrderId), o._id);
  }

  const ops = [];
  let linked = 0;

  for (const delivery of deliveries) {
    const deliveryId = String(delivery._id || delivery.id);
    const tracking = delivery.trackingNumber != null ? String(delivery.trackingNumber) : null;
    const ref = String(delivery.businessReference || '').trim();
    const orderId =
      byDeliveryId.get(deliveryId) ||
      (tracking ? byTracking.get(tracking) : null) ||
      (ref ? byOrderId.get(ref) : null) ||
      (ref ? byShopify.get(ref) : null) ||
      null;

    const doc = upsertDocFromDelivery(delivery, orderId);
    if (!doc) continue;
    if (orderId) linked += 1;

    ops.push({
      updateOne: {
        filter: { bostaDeliveryId: doc.bostaDeliveryId },
        update: { $set: doc },
        upsert: true,
      },
    });
  }

  if (ops.length) {
    const BATCH = 500;
    for (let i = 0; i < ops.length; i += BATCH) {
      await BostaReturn.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
    }
  }

  const result = { upserted: ops.length, linked, fetched: byId.size };
  logger.info(result, 'Bosta returns sync finished');
  return result;
}

/**
 * Dashboard metrics from synced Bosta returns in [from, to].
 */
export async function bostaReturnsForRange({ from, to }) {
  const rows = await BostaReturn.find({
    returnedAt: { $gte: from, $lte: to },
  }).lean();

  const byType = {
    rto: 0,
    customer_return: 0,
    exchange: 0,
    send: 0,
    other: 0,
  };

  let amount = 0;
  let linkedCount = 0;

  for (const row of rows) {
    const code = row.typeCode;
    // Bosta type codes: 10 SEND, 15 EXCHANGE, 20 CRP, 25 RTO
    if (code === 25 || /return to origin|rto/i.test(String(row.typeValue || ''))) byType.rto += 1;
    else if (code === 20 || /customer return/i.test(String(row.typeValue || ''))) byType.customer_return += 1;
    else if (code === 15 || code === 30 || /exchange/i.test(String(row.typeValue || ''))) byType.exchange += 1;
    else if (code === 10) byType.send += 1;
    else byType.other += 1;

    amount += row.codAmount || 0;
    if (row.orderId) linkedCount += 1;
  }

  const linkedRows = rows.filter((r) => r.orderId);
  const linkedRto = linkedRows.filter(
    (r) =>
      r.typeCode === 25 ||
      /return to origin|rto/i.test(String(r.typeValue || '')) ||
      r.typeCode === 20 ||
      /customer return/i.test(String(r.typeValue || ''))
  ).length;

  return {
    count: rows.length,
    /** Gazelle-linked returns only — use for executive return rate (same Bosta account may hold other shops). */
    linkedCount,
    linkedRtoCount: linkedRto,
    amount,
    linkedAmount: linkedRows.reduce((s, r) => s + (r.codAmount || 0), 0),
    byType,
    rows,
  };
}

export { searchDeliveries, findLinkedOrder, normalizePhone, parseBostaDate };

export default { syncBostaReturns, bostaReturnsForRange, searchDeliveries };
