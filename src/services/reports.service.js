import Order from '../models/Order.js';
import PaymobReceived from '../models/PaymobReceived.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import InventoryLedger from '../models/InventoryLedger.js';
import Employee from '../models/Employee.js';
// Register for Order.populate('customerId') in returns analytics (dashboard details).
import '../models/Customer.js';
import * as kpiService from './kpi.service.js';
import logger from '../utils/logger.js';
import { ORDERS_PLACED_FROM_YMD } from '../constants/index.js';
import { classifyReturnKind } from '../utils/returnKind.js';

/** Business calendar for Gazelle (Egypt). */
const BUSINESS_TZ = 'Africa/Cairo';

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format a Date as YYYY-MM-DD in the business timezone. */
function formatYmdInTz(date, timeZone = BUSINESS_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Convert a calendar YYYY-MM-DD in BUSINESS_TZ to a UTC Date at start/end of that day.
 */
function zonedDayBound(ymd, end = false, timeZone = BUSINESS_TZ) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hour = end ? 23 : 0;
  const minute = end ? 59 : 0;
  const second = end ? 59 : 0;
  const ms = end ? 999 : 0;

  // Guess UTC instant, then correct using the zone offset at that instant.
  let utc = Date.UTC(y, mo - 1, d, hour, minute, second, ms);
  const asTz = new Date(utc).toLocaleString('en-US', { timeZone });
  const asUtc = new Date(utc).toLocaleString('en-US', { timeZone: 'UTC' });
  const shift = new Date(asUtc).getTime() - new Date(asTz).getTime();
  utc += shift;

  // Re-check after shift (DST edges).
  const ymdCheck = formatYmdInTz(new Date(utc), timeZone);
  if (ymdCheck !== `${m[1]}-${m[2]}-${m[3]}`) {
    utc += (ymdCheck < `${m[1]}-${m[2]}-${m[3]}` ? 1 : -1) * 60 * 60 * 1000;
  }
  return new Date(utc);
}

function startOfBusinessDay(ymdOrDate) {
  if (typeof ymdOrDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ymdOrDate)) {
    return zonedDayBound(ymdOrDate.slice(0, 10), false);
  }
  const ymd = formatYmdInTz(ymdOrDate instanceof Date ? ymdOrDate : nowDate());
  return zonedDayBound(ymd, false);
}

function endOfBusinessDay(ymdOrDate) {
  if (typeof ymdOrDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ymdOrDate)) {
    return zonedDayBound(ymdOrDate.slice(0, 10), true);
  }
  const ymd = formatYmdInTz(ymdOrDate instanceof Date ? ymdOrDate : nowDate());
  return zonedDayBound(ymd, true);
}

function nowDate() {
  return new Date();
}

/**
 * Clamp a dashboard range so order-based metrics start at ORDERS_PLACED_FROM_YMD.
 * Money KPIs keep the original `range` unchanged.
 */
function ordersMetricsRange(range) {
  const floorYmd = ORDERS_PLACED_FROM_YMD;
  const fromYmd = range?.fromYmd || formatYmdInTz(range.from);
  const toYmd = range?.toYmd || formatYmdInTz(range.to);
  const clampedFromYmd = fromYmd < floorYmd ? floorYmd : fromYmd;
  if (clampedFromYmd > toYmd) {
    // Selected window is entirely before cutover — empty order window.
    return {
      ...range,
      from: startOfBusinessDay(floorYmd),
      to: startOfBusinessDay(floorYmd),
      fromYmd: floorYmd,
      toYmd: floorYmd,
      empty: true,
    };
  }
  return {
    ...range,
    from: startOfBusinessDay(clampedFromYmd),
    to: range.to,
    fromYmd: clampedFromYmd,
    toYmd,
    empty: false,
  };
}

function listYmdInclusive(fromYmd, toYmd) {
  const out = [];
  const m = String(fromYmd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const n = String(toYmd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !n) return out;

  let y = Number(m[1]);
  let mo = Number(m[2]);
  let d = Number(m[3]);
  const endKey = Number(n[1]) * 10000 + Number(n[2]) * 100 + Number(n[3]);

  for (let i = 0; i < 400; i += 1) {
    const key = y * 10000 + mo * 100 + d;
    out.push(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    if (key >= endKey) break;
    d += 1;
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d > dim) {
      d = 1;
      mo += 1;
      if (mo > 12) {
        mo = 1;
        y += 1;
      }
    }
  }
  return out;
}

function rangeForPreset({ preset, date, from, to }) {
  const todayYmd = formatYmdInTz(nowDate());

  if (preset === 'day' || preset === 'today') {
    const ymd = (date && String(date).slice(0, 10)) || todayYmd;
    return { from: startOfBusinessDay(ymd), to: endOfBusinessDay(ymd), fromYmd: ymd, toYmd: ymd };
  }

  if (preset === 'custom') {
    const fromYmd = from ? String(from).slice(0, 10) : formatYmdInTz(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
    const toYmd = to ? String(to).slice(0, 10) : todayYmd;
    return { from: startOfBusinessDay(fromYmd), to: endOfBusinessDay(toYmd), fromYmd, toYmd };
  }

  if (preset === 'week') {
    const toYmd = todayYmd;
    const fromDate = new Date(nowDate().getTime() - 6 * 24 * 60 * 60 * 1000);
    const fromYmd = formatYmdInTz(fromDate);
    return { from: startOfBusinessDay(fromYmd), to: endOfBusinessDay(toYmd), fromYmd, toYmd };
  }

  if (preset === 'month') {
    const toYmd = todayYmd;
    const fromDate = new Date(nowDate().getTime() - 29 * 24 * 60 * 60 * 1000);
    const fromYmd = formatYmdInTz(fromDate);
    return { from: startOfBusinessDay(fromYmd), to: endOfBusinessDay(toYmd), fromYmd, toYmd };
  }

  return {
    from: startOfBusinessDay(todayYmd),
    to: endOfBusinessDay(todayYmd),
    fromYmd: todayYmd,
    toYmd: todayYmd,
  };
}

const dateToStringCairo = (field) => ({
  $dateToString: { format: '%Y-%m-%d', date: field, timezone: BUSINESS_TZ },
});


async function paymobReceivedForRange({ from, to }) {
  // Sync Accept → ledger, but never trust an empty live page over real receipts.
  try {
    const { isPaymobApiConfigured, syncAndSumPaymobReceived } = await import(
      '../integrations/paymob/transactions.service.js'
    );
    if (isPaymobApiConfigured()) {
      const live = await Promise.race([
        syncAndSumPaymobReceived({ from, to, maxPages: 80 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Paymob API timeout')), 45000)),
      ]);
      if ((live?.count || 0) > 0 || (live?.amount || 0) > 0) {
        return live;
      }
      // Fall through to ledger when Accept returned pages=1 / amount=0.
      logger.warn(
        { live, from, to },
        'Paymob live sum empty — using ledger for online payment total'
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Paymob API sync skipped — falling back to ledger');
  }

  const [row] = await PaymobReceived.aggregate([
    { $match: { receivedAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: null,
        amount: { $sum: '$amountEgp' },
        count: { $sum: 1 },
      },
    },
  ]);
  if ((row?.count || 0) > 0) {
    return { amount: row.amount ?? 0, count: row.count ?? 0, source: 'paymob_ledger', real: true };
  }

  return { amount: 0, count: 0, source: 'paymob', real: true };
}

async function codCollectedForRange({ from, to }) {
  // Prefer live aggregate when sync finishes; raise timeout so Cairo-week COD can refresh.
  try {
    const { isBostaConfigured, syncAndSumDeliveredCod } = await import(
      '../integrations/bosta/cod.service.js'
    );
    if (isBostaConfigured()) {
      const live = await Promise.race([
        syncAndSumDeliveredCod({ from, to, maxPages: 60 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Bosta COD timeout')), 45000)),
      ]);
      return live;
    }
  } catch (err) {
    logger.warn({ err }, 'Bosta COD sync skipped — using OMS stamps');
  }

  const [bostaRow] = await Order.aggregate([
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

  return {
    amount: bostaRow?.amount ?? 0,
    count: bostaRow?.count ?? 0,
    source: 'bosta',
    real: true,
  };
}

/**
 * Outstanding COD for the admin-selected days only (Bosta COD shipments):
 * - delivered in range and still unpaid, or
 * - still with courier and placed in range.
 * Excludes customer pickup / local courier (no Bosta cash cycle).
 */
async function codLeftToCollect({ from, to }) {
  const [row] = await Order.aggregate([
    {
      $match: {
        $or: [{ paymentMethod: 'cod' }, { paymentMethod: { $exists: false } }, { paymentMethod: null }],
        $and: [
          {
            $or: [
              { shippingMethod: 'bosta' },
              { shippingMethod: { $exists: false } },
              { shippingMethod: null },
            ],
          },
          {
            $or: [
              {
                internalStatus: 'delivered',
                deliveredAt: { $gte: from, $lte: to },
              },
              {
                internalStatus: { $in: ['picked_up_by_bosta', 'in_transit', 'failed_delivery'] },
                placedAt: { $gte: from, $lte: to },
              },
            ],
          },
        ],
      },
    },
    {
      $addFields: {
        collected: { $ifNull: ['$bostaCollectedAmount', 0] },
        due: {
          $add: [{ $ifNull: ['$totalSellingPrice', 0] }, { $ifNull: ['$shippingFee', 0] }],
        },
      },
    },
    { $match: { $expr: { $and: [{ $gt: ['$due', 0] }, { $lt: ['$collected', '$due'] }] } } },
    {
      $group: {
        _id: null,
        amount: { $sum: { $subtract: ['$due', '$collected'] } },
        count: { $sum: 1 },
      },
    },
  ]);
  return {
    amount: row?.amount ?? 0,
    count: row?.count ?? 0,
    real: true,
    source: 'oms_open_cod_in_range',
  };
}

/** Bosta returns in range (synced cache) — used for executive return-rate %. */
async function bostaReturnCountForRange({ from, to }) {
  try {
    const { syncBostaReturns, bostaReturnsForRange } = await import(
      '../integrations/bosta/returns.service.js'
    );
    await Promise.race([
      syncBostaReturns({ from, to, maxPages: 30 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Bosta returns sync timeout')), 10000)),
    ]).catch((err) => logger.warn({ err }, 'Bosta returns sync for return-rate skipped'));

    const bosta = await bostaReturnsForRange({ from, to });
    return {
      count: bosta.linkedCount ?? 0,
      accountCount: bosta.count ?? 0,
      amount: bosta.linkedAmount ?? 0,
      linkedCount: bosta.linkedCount ?? 0,
      linkedRtoCount: bosta.linkedRtoCount ?? 0,
      source: 'bosta',
    };
  } catch (err) {
    logger.warn({ err }, 'Bosta return count failed');
    return { count: 0, accountCount: 0, amount: 0, linkedCount: 0, linkedRtoCount: 0, source: 'bosta' };
  }
}

async function deliveredCountForRange({ from, to }) {
  return Order.countDocuments({
    internalStatus: 'delivered',
    deliveredAt: { $gte: from, $lte: to },
  });
}

/** Warehouse confirms only — secondary analytics, not executive return-rate. */
async function gazelleReturnCountForRange({ from, to }) {
  return OrderStatusHistory.countDocuments({
    toStatus: 'returned_to_stock',
    createdAt: { $gte: from, $lte: to },
  });
}

async function returnsForRange({ from, to }) {
  const { bostaReturnsForRange } = await import('../integrations/bosta/returns.service.js');
  const bosta = await bostaReturnsForRange({ from, to });
  if (bosta.count > 0) {
    return {
      amount: bosta.amount,
      count: bosta.count,
      bostaCount: bosta.count,
      bostaAmount: bosta.amount,
      confirmedInStockCount: 0,
      confirmedInStockAmount: 0,
      byType: bosta.byType,
    };
  }

  // Fallback only when Bosta cache is empty for the range.
  const [stock] = await OrderStatusHistory.aggregate([
    {
      $match: {
        toStatus: 'returned_to_stock',
        createdAt: { $gte: from, $lte: to },
      },
    },
    {
      $lookup: {
        from: 'orders',
        localField: 'orderId',
        foreignField: '_id',
        as: 'order',
      },
    },
    { $unwind: '$order' },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        amount: { $sum: { $ifNull: ['$order.totalSellingPrice', 0] } },
      },
    },
  ]);
  return {
    amount: stock?.amount ?? 0,
    count: stock?.count ?? 0,
    bostaCount: 0,
    bostaAmount: 0,
    confirmedInStockCount: stock?.count ?? 0,
    confirmedInStockAmount: stock?.amount ?? 0,
    byType: null,
  };
}

async function dailyBreakdownForRange({ from, to, fromYmd, toYmd }) {
  const [placedRows, paymobRows, codRows, stockReturnRows, bostaReturnRows] = await Promise.all([
    Order.aggregate([
      { $match: { placedAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: dateToStringCairo('$placedAt'),
          revenueExclShipping: { $sum: '$totalSellingPrice' },
          orderCount: { $sum: 1 },
        },
      },
    ]),
    PaymobReceived.aggregate([
      { $match: { receivedAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: dateToStringCairo('$receivedAt'),
          paymobReceived: { $sum: '$amountEgp' },
          paymobCount: { $sum: 1 },
        },
      },
    ]),
    Order.aggregate([
      {
        $match: {
          paymentMethod: 'cod',
          bostaCollectedAt: { $gte: from, $lte: to },
          bostaCollectedAmount: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: dateToStringCairo('$bostaCollectedAt'),
          codCollected: { $sum: '$bostaCollectedAmount' },
          codCount: { $sum: 1 },
        },
      },
    ]),
    OrderStatusHistory.aggregate([
      {
        $match: {
          toStatus: 'returned_to_stock',
          createdAt: { $gte: from, $lte: to },
        },
      },
      {
        $lookup: {
          from: 'orders',
          localField: 'orderId',
          foreignField: '_id',
          as: 'order',
        },
      },
      { $unwind: '$order' },
      {
        $group: {
          _id: dateToStringCairo('$createdAt'),
          returnCount: { $sum: 1 },
          returnAmount: { $sum: { $ifNull: ['$order.totalSellingPrice', 0] } },
        },
      },
    ]),
    (async () => {
      const BostaReturn = (await import('../models/BostaReturn.js')).default;
      return BostaReturn.aggregate([
        { $match: { returnedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: dateToStringCairo('$returnedAt'),
            returnCount: { $sum: 1 },
            returnAmount: { $sum: { $ifNull: ['$codAmount', 0] } },
          },
        },
      ]);
    })(),
  ]);

  const returnRows = (bostaReturnRows?.length ? bostaReturnRows : stockReturnRows) || [];

  const emptyRow = (date) => ({
    date,
    revenueExclShipping: 0,
    orderCount: 0,
    paymobReceived: 0,
    paymobCount: 0,
    codCollected: 0,
    codCount: 0,
    returnCount: 0,
    returnAmount: 0,
  });

  const byDate = new Map();
  const ensure = (date) => {
    if (!byDate.has(date)) byDate.set(date, emptyRow(date));
    return byDate.get(date);
  };

  // Always include every calendar day in the selected range (Cairo).
  const startYmd = fromYmd || formatYmdInTz(from);
  const endYmd = toYmd || formatYmdInTz(to);
  for (const ymd of listYmdInclusive(startYmd, endYmd)) ensure(ymd);

  for (const row of placedRows) {
    ensure(row._id).revenueExclShipping = row.revenueExclShipping;
    ensure(row._id).orderCount = row.orderCount;
  }
  for (const row of paymobRows) {
    ensure(row._id).paymobReceived = row.paymobReceived;
    ensure(row._id).paymobCount = row.paymobCount;
  }
  for (const row of codRows) {
    ensure(row._id).codCollected = row.codCollected;
    ensure(row._id).codCount = row.codCount;
  }
  for (const row of returnRows) {
    ensure(row._id).returnCount = row.returnCount;
    ensure(row._id).returnAmount = row.returnAmount;
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function paymentSplitForRange({ from, to }) {
  const pipeline = [
    { $match: { placedAt: { $gte: from, $lte: to } } },
    {
      $addFields: {
        paymentMethodNorm: { $ifNull: ['$paymentMethod', 'cod'] },
        shippingFeeSafe: { $ifNull: ['$shippingFee', 0] },
      },
    },
    {
      $group: {
        _id: '$paymentMethodNorm',
        count: { $sum: 1 },
        revenueExclShipping: { $sum: '$totalSellingPrice' },
        revenueInclShipping: { $sum: { $add: ['$totalSellingPrice', '$shippingFeeSafe'] } },
        bostaCollectedAmount: { $sum: { $ifNull: ['$bostaCollectedAmount', 0] } },
        onlinePaymentAmount: { $sum: { $ifNull: ['$onlinePaymentAmount', 0] } },
      },
    },
  ];

  const rows = await Order.aggregate(pipeline);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const totalExcl = rows.reduce((s, r) => s + r.revenueExclShipping, 0);
  const totalIncl = rows.reduce((s, r) => s + r.revenueInclShipping, 0);

  const asBlock = (key) => {
    const r = rows.find((x) => x._id === key);
    const count = r?.count ?? 0;
    const revenueExclShipping = r?.revenueExclShipping ?? 0;
    const revenueInclShipping = r?.revenueInclShipping ?? 0;
    const bostaCollectedAmount = r?.bostaCollectedAmount ?? 0;
    const onlinePaymentAmount = r?.onlinePaymentAmount ?? 0;
    return {
      count,
      revenueExclShipping,
      revenueInclShipping,
      bostaCollectedAmount,
      onlinePaymentAmount,
      percentByCount: totalCount > 0 ? Math.round((count / totalCount) * 100) : 0,
      percentByAmountExclShipping: totalExcl > 0 ? Math.round((revenueExclShipping / totalExcl) * 100) : 0,
      percentByAmountInclShipping: totalIncl > 0 ? Math.round((revenueInclShipping / totalIncl) * 100) : 0,
    };
  };

  return {
    totalCount,
    totals: {
      revenueExclShipping: totalExcl,
      revenueInclShipping: totalIncl,
      shippingFeeTotal: Math.max(0, totalIncl - totalExcl),
    },
    cod: asBlock('cod'),
    online: asBlock('online'),
  };
}

async function topProductsForRange({ from, to, limit = 8 }) {
  const match = { internalStatus: 'delivered', deliveredAt: { $gte: from, $lte: to } };
  const pipeline = [
    { $match: match },
    { $unwind: '$items' },
    {
      $addFields: {
        unitCogsSafe: { $ifNull: ['$items.unitCogs', 0] },
      },
    },
    {
      $group: {
        _id: '$items.sku',
        sku: { $first: '$items.sku' },
        revenue: { $sum: { $multiply: ['$items.unitSellingPrice', '$items.quantity'] } },
        cogs: { $sum: { $multiply: ['$unitCogsSafe', '$items.quantity'] } },
        quantity: { $sum: '$items.quantity' },
      },
    },
    { $addFields: { margin: { $subtract: ['$revenue', '$cogs'] } } },
    { $sort: { revenue: -1 } },
    { $limit: limit },
  ];

  const rows = await Order.aggregate(pipeline);
  return rows;
}

async function employeeKpisForRange({ from, to, limit = 10 }) {
  const employees = await Employee.find({ isActive: true })
    .populate('userId', 'name role')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const rows = [];
  for (const emp of employees) {
    const userId = emp.userId?._id;
    if (!userId) continue;
    const kpis = await kpiService.getEmployeeKpis(userId, { from, to });
    rows.push({
      employeeId: emp._id,
      employeeName: emp.userId?.name,
      role: emp.userId?.role,
      ...kpis,
    });
  }
  return rows;
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function medianOf(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function hoursBetween(from, to) {
  if (!from || !to) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / (1000 * 60 * 60);
}

function daysBetween(from, to) {
  const h = hoursBetween(from, to);
  return h == null ? null : h / 24;
}

/**
 * Delivery success + transit times for the selected range (OMS + Bosta statuses).
 * Success = delivered ÷ (delivered + failed + refused/RTO returns).
 */
async function deliveryPerformanceForRange({ from, to }) {
  const [
    delivered,
    failed,
    refusedReturns,
    transitOrders,
    deliveredByZone,
    failedByZone,
    refusedByZone,
  ] = await Promise.all([
    Order.countDocuments({
      internalStatus: 'delivered',
      deliveredAt: { $gte: from, $lte: to },
    }),
    Order.countDocuments({
      internalStatus: 'failed_delivery',
      lastStatusUpdateAt: { $gte: from, $lte: to },
    }),
    Order.countDocuments({
      isExchangeOrder: { $ne: true },
      isReturnOrder: { $ne: true },
      deliveredAt: { $exists: false },
      internalStatus: {
        $in: ['returning_to_origin', 'returned_awaiting_receipt', 'returned_to_stock', 'back_from_local_shipping'],
      },
      lastStatusUpdateAt: { $gte: from, $lte: to },
    }),
    Order.find({
      internalStatus: 'delivered',
      deliveredAt: { $gte: from, $lte: to },
      placedAt: { $exists: true },
    })
      .select('placedAt deliveredAt')
      .lean(),
    Order.aggregate([
      {
        $match: {
          internalStatus: 'delivered',
          deliveredAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: { $ifNull: ['$shippingAddress.zone', '—'] },
          count: { $sum: 1 },
        },
      },
    ]),
    Order.aggregate([
      {
        $match: {
          internalStatus: 'failed_delivery',
          lastStatusUpdateAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: { $ifNull: ['$shippingAddress.zone', '—'] },
          count: { $sum: 1 },
        },
      },
    ]),
    Order.aggregate([
      {
        $match: {
          isExchangeOrder: { $ne: true },
          isReturnOrder: { $ne: true },
          deliveredAt: { $exists: false },
          internalStatus: {
            $in: ['returning_to_origin', 'returned_awaiting_receipt', 'returned_to_stock', 'back_from_local_shipping'],
          },
          lastStatusUpdateAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: { $ifNull: ['$shippingAddress.zone', '—'] },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const attempted = delivered + failed + refusedReturns;
  const successRate = attempted > 0 ? pct(delivered, attempted) : null;

  const byZoneMap = new Map();
  for (const row of deliveredByZone || []) {
    const zone = row?._id || '—';
    byZoneMap.set(zone, { zone, delivered: row.count || 0, failed: 0, refused: 0 });
  }
  for (const row of failedByZone || []) {
    const zone = row?._id || '—';
    const cur = byZoneMap.get(zone) || { zone, delivered: 0, failed: 0, refused: 0 };
    cur.failed = row.count || 0;
    byZoneMap.set(zone, cur);
  }
  for (const row of refusedByZone || []) {
    const zone = row?._id || '—';
    const cur = byZoneMap.get(zone) || { zone, delivered: 0, failed: 0, refused: 0 };
    cur.refused = row.count || 0;
    byZoneMap.set(zone, cur);
  }

  const byZone = [...byZoneMap.values()]
    .map((z) => {
      const attempt = z.delivered + z.failed + z.refused;
      return {
        ...z,
        attempted: attempt,
        successRate: attempt > 0 ? pct(z.delivered, attempt) : null,
      };
    })
    .sort((a, b) => b.attempted - a.attempted)
    .slice(0, 10);

  const hours = transitOrders
    .map((o) => hoursBetween(o.placedAt, o.deliveredAt))
    .filter((h) => h != null && h >= 0 && h < 24 * 60)
    .sort((a, b) => a - b);

  const avgHours = hours.length
    ? round1(hours.reduce((s, h) => s + h, 0) / hours.length)
    : null;
  const medianHours = hours.length ? round1(medianOf(hours)) : null;
  const p90Hours =
    hours.length > 0 ? round1(hours[Math.min(hours.length - 1, Math.floor(hours.length * 0.9))]) : null;

  return {
    successRate,
    delivered,
    failed,
    refused: refusedReturns,
    attempted,
    transit: {
      avgHours,
      medianHours,
      p90Hours,
      avgDays: avgHours == null ? null : round1(avgHours / 24),
      medianDays: medianHours == null ? null : round1(medianHours / 24),
      sampleSize: hours.length,
    },
    byZone,
  };
}

/**
 * Collected vs expected cash by payment method (Shopify/OMS expected · Bosta/Paymob collected).
 */
async function moneyCollectedVsExpectedForRange(range, { paymobReceived, codCollected } = {}) {
  const { from, to } = range;
  const { omsCodCollectAmount } = await import('../utils/omsCod.js');

  const [codDelivered, onlinePaid] = await Promise.all([
    Order.find({
      $or: [{ paymentMethod: 'cod' }, { paymentMethod: { $exists: false } }, { paymentMethod: null }],
      internalStatus: 'delivered',
      deliveredAt: { $gte: from, $lte: to },
      isReturnOrder: { $ne: true },
    })
      .select(
        'totalSellingPrice shippingFee paymentMethod onlinePaymentStatus onlinePaidAt isCreatorOrder isExchangeOrder isReturnOrder exchangeCreditAmount bostaCollectedAmount'
      )
      .lean(),
    Order.find({
      paymentMethod: 'online',
      $or: [
        { onlinePaidAt: { $gte: from, $lte: to } },
        { onlinePaidAt: { $exists: false }, placedAt: { $gte: from, $lte: to }, onlinePaymentStatus: 'paid' },
      ],
    })
      .select('totalSellingPrice shippingFee onlinePaymentAmount onlinePaymentStatus')
      .lean(),
  ]);

  let codExpected = 0;
  let codCollectedOnDelivered = 0;
  for (const order of codDelivered) {
    const due = omsCodCollectAmount(order);
    codExpected += due;
    const got = Number(order.bostaCollectedAmount) || 0;
    codCollectedOnDelivered += Math.min(got, due || got);
  }
  codExpected = roundMoney(codExpected);
  codCollectedOnDelivered = roundMoney(codCollectedOnDelivered);

  let onlineExpected = 0;
  for (const order of onlinePaid) {
    const paid = Number(order.onlinePaymentAmount);
    if (Number.isFinite(paid) && paid > 0) onlineExpected += paid;
    else onlineExpected += (Number(order.totalSellingPrice) || 0) + (Number(order.shippingFee) || 0);
  }
  onlineExpected = roundMoney(onlineExpected);

  const codGot = roundMoney(codCollected?.amount ?? codCollectedOnDelivered);
  const onlineGot = roundMoney(paymobReceived?.amount ?? 0);

  const byMethod = {
    cod: {
      label: 'Cash on delivery (Bosta)',
      expected: codExpected,
      collected: codGot,
      gap: roundMoney(codExpected - codGot),
      expectedCount: codDelivered.length,
      collectedCount: codCollected?.count ?? 0,
    },
    online: {
      label: 'Online (Paymob)',
      expected: onlineExpected,
      collected: onlineGot,
      gap: roundMoney(onlineExpected - onlineGot),
      expectedCount: onlinePaid.length,
      collectedCount: paymobReceived?.count ?? 0,
    },
  };

  const expectedTotal = roundMoney(codExpected + onlineExpected);
  const collectedTotal = roundMoney(codGot + onlineGot);

  return {
    byMethod,
    totals: {
      expected: expectedTotal,
      collected: collectedTotal,
      gap: roundMoney(expectedTotal - collectedTotal),
      collectionRate: expectedTotal > 0 ? pct(collectedTotal, expectedTotal) : null,
    },
  };
}

/**
 * Refund / return detail: gender, reason, days after delivery.
 */
async function refundsDetailForRange({ from, to }) {
  const { resolveGender } = await import('../utils/gender.js');

  const history = await OrderStatusHistory.find({
    toStatus: 'returned_to_stock',
    createdAt: { $gte: from, $lte: to },
  })
    .select('orderId createdAt')
    .lean();

  const ids = [...new Set(history.map((h) => String(h.orderId)))];
  const refundAtByOrder = {};
  for (const h of history) {
    const id = String(h.orderId);
    const t = new Date(h.createdAt).getTime();
    if (!refundAtByOrder[id] || t < refundAtByOrder[id]) refundAtByOrder[id] = t;
  }

  const orders = ids.length
    ? await Order.find({ _id: { $in: ids } })
        .populate('customerId', 'fullName gender')
        .select(
          'shopifyOrderName shopifyOrderId paymentMethod totalSellingPrice shippingFee customerId shippingAddress isExchangeOrder isReturnOrder deliveredAt cancellationReason placedAt returnReason returnReasonNote'
        )
        .lean()
    : [];

  const gender = { male: 0, female: 0, unknown: 0 };
  const reason = { refund: 0, refused: 0, exchange: 0 };
  const returnReasons = {
    sizing_fit: 0,
    product_issue: 0,
    wrong_item: 0,
    changed_mind: 0,
    delivery_issue: 0,
    refused_at_door: 0,
    other: 0,
    unclassified: 0,
  };
  const RETURN_REASON_LABELS = {
    sizing_fit: 'Sizing / fit',
    product_issue: 'Product issue',
    wrong_item: 'Wrong item',
    changed_mind: 'Changed mind',
    delivery_issue: 'Delivery issue',
    refused_at_door: 'Refused at door',
    other: 'Other',
    unclassified: 'Historic / unclassified',
  };
  const daySamples = [];
  const buckets = {
    'same-day': 0,
    '1-3d': 0,
    '4-7d': 0,
    '8-14d': 0,
    '15d+': 0,
    'never-delivered': 0,
  };
  const rows = [];
  let amount = 0;

  for (const order of orders) {
    const kind = classifyReturnKind(order);
    reason[kind] = (reason[kind] || 0) + 1;
    amount += Number(order.totalSellingPrice) || 0;

    const rrKey = order.returnReason && RETURN_REASON_LABELS[order.returnReason] ? order.returnReason : 'unclassified';
    returnReasons[rrKey] = (returnReasons[rrKey] || 0) + 1;

    const name = order.customerId?.fullName || order.shippingAddress?.fullName || '';
    const g = resolveGender(order.customerId?.gender, name);
    gender[g] = (gender[g] || 0) + 1;

    const refundAt = refundAtByOrder[String(order._id)]
      ? new Date(refundAtByOrder[String(order._id)])
      : null;
    let daysAfter = null;
    if (order.deliveredAt && refundAt) {
      daysAfter = daysBetween(order.deliveredAt, refundAt);
      if (daysAfter != null && daysAfter >= 0) {
        daySamples.push(daysAfter);
        if (daysAfter < 1) buckets['same-day'] += 1;
        else if (daysAfter <= 3) buckets['1-3d'] += 1;
        else if (daysAfter <= 7) buckets['4-7d'] += 1;
        else if (daysAfter <= 14) buckets['8-14d'] += 1;
        else buckets['15d+'] += 1;
      }
    } else {
      buckets['never-delivered'] += 1;
    }

    rows.push({
      orderId: String(order._id),
      orderName: order.shopifyOrderName || order.shopifyOrderId || String(order._id),
      gender: g,
      reason: kind,
      returnReason: rrKey,
      returnReasonLabel: RETURN_REASON_LABELS[rrKey],
      reasonLabel:
        kind === 'exchange'
          ? 'Exchange'
          : kind === 'refund'
            ? 'Refund / post-delivery return'
            : 'Refused / failed (never delivered)',
      daysAfterDelivery: daysAfter == null ? null : round1(daysAfter),
      amount: Number(order.totalSellingPrice) || 0,
      note: order.returnReasonNote || order.cancellationReason || null,
      deliveredAt: order.deliveredAt || null,
      returnedAt: refundAt,
    });
  }

  daySamples.sort((a, b) => a - b);
  const genderMix = mixFromCounts(gender);
  const reasonMix = mixFromCounts(reason);
  const returnReasonMix = mixFromCounts(returnReasons);

  return {
    count: orders.length,
    amount: roundMoney(amount),
    gender: {
      ...genderMix,
      malePercent: genderMix.male?.percent ?? 0,
      femalePercent: genderMix.female?.percent ?? 0,
      unknownPercent: genderMix.unknown?.percent ?? 0,
    },
    reason: {
      ...reasonMix,
      refundPercent: reasonMix.refund?.percent ?? 0,
      refusedPercent: reasonMix.refused?.percent ?? 0,
      exchangePercent: reasonMix.exchange?.percent ?? 0,
    },
    returnReasons: {
      ...returnReasonMix,
      // convenient mirrors for common UI labels
      sizingFitPercent: returnReasonMix.sizing_fit?.percent ?? 0,
    },
    daysAfterDelivery: {
      avg: daySamples.length
        ? round1(daySamples.reduce((s, d) => s + d, 0) / daySamples.length)
        : null,
      median: daySamples.length ? round1(medianOf(daySamples)) : null,
      sampleSize: daySamples.length,
      buckets: Object.entries(buckets).map(([label, count]) => ({ label, count })),
    },
    rows: rows
      .sort((a, b) => (b.returnedAt?.getTime?.() || 0) - (a.returnedAt?.getTime?.() || 0))
      .slice(0, 40),
  };
}

/**
 * Exchange frequency by collected SKU / size (what customers send back).
 */
async function exchangeSkuStatsForRange({ from, to }) {
  const exchanges = await Order.find({
    isExchangeOrder: true,
    placedAt: { $gte: from, $lte: to },
  })
    .select('bostaReturnItems items shopifyOrderName')
    .lean();

  const bySku = new Map();
  const bySize = new Map();

  for (const order of exchanges) {
    const lines =
      Array.isArray(order.bostaReturnItems) && order.bostaReturnItems.length
        ? order.bostaReturnItems
        : [];
    for (const line of lines) {
      const sku = String(line.sku || 'unknown').trim() || 'unknown';
      const size =
        line.size != null && String(line.size).trim() !== ''
          ? String(line.size).trim()
          : '—';
      const qty = Number(line.quantity) || 1;
      const key = `${sku}::${size}`;
      const cur = bySku.get(key) || {
        sku,
        size,
        color: line.color || '',
        title: line.title || '',
        quantity: 0,
        exchangeOrders: 0,
      };
      cur.quantity += qty;
      cur.exchangeOrders += 1;
      bySku.set(key, cur);

      const sizeRow = bySize.get(size) || { size, quantity: 0, exchangeOrders: 0 };
      sizeRow.quantity += qty;
      sizeRow.exchangeOrders += 1;
      bySize.set(size, sizeRow);
    }
  }

  const allSkus = [...bySku.values()];
  const allSizes = [...bySize.values()];

  // `linesCollected` must include every exchange line, not only the top rows we display.
  const linesCollected = allSkus.reduce((s, r) => s + (Number(r.quantity) || 0), 0);

  const topSkus = allSkus.sort((a, b) => b.quantity - a.quantity).slice(0, 20);
  const topSizes = allSizes.sort((a, b) => b.quantity - a.quantity).slice(0, 12);

  return {
    exchangeOrderCount: exchanges.length,
    linesCollected,
    topSkus,
    topSizes,
  };
}

function mixFromCounts(counts) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const shares = {};
  for (const [key, count] of Object.entries(counts)) {
    shares[key] = { count, percent: pct(count, total) };
  }
  return { total, ...shares };
}

/** Chat / social manual channels vs Shopify online store. */
const CHAT_MANUAL_SOURCES = new Set(['whatsapp', 'phone', 'instagram', 'facebook', 'other']);

async function orderMixForRange({ from, to }) {
  const orders = await Order.find({ placedAt: { $gte: from, $lte: to } })
    .select('paymentMethod orderSource manualSource totalSellingPrice')
    .lean();

  const payment = { cod: 0, online: 0 };
  const channel = { chat: 0, online_store: 0, other: 0 };
  let revenueCod = 0;
  let revenueOnline = 0;

  for (const o of orders) {
    const pay = o.paymentMethod === 'online' ? 'online' : 'cod';
    payment[pay] += 1;
    if (pay === 'online') revenueOnline += o.totalSellingPrice || 0;
    else revenueCod += o.totalSellingPrice || 0;

    if (o.orderSource === 'shopify') {
      channel.online_store += 1;
    } else if (o.orderSource === 'manual' && CHAT_MANUAL_SOURCES.has(o.manualSource || 'other')) {
      channel.chat += 1;
    } else if (o.orderSource === 'manual' && o.manualSource === 'website') {
      channel.online_store += 1;
    } else {
      channel.other += 1;
    }
  }

  const paymentMix = mixFromCounts(payment);
  const channelMix = mixFromCounts(channel);

  return {
    payment: {
      ...paymentMix,
      revenueCod,
      revenueOnline,
      codPercent: paymentMix.cod?.percent ?? 0,
      onlinePercent: paymentMix.online?.percent ?? 0,
    },
    channel: {
      ...channelMix,
      chatPercent: channelMix.chat?.percent ?? 0,
      onlineStorePercent: channelMix.online_store?.percent ?? 0,
    },
  };
}

async function returnsAnalyticsForRange({ from, to }) {
  const { resolveGender } = await import('../utils/gender.js');
  const { bostaReturnsForRange, syncBostaReturns } = await import('../integrations/bosta/returns.service.js');

  // Prefer cached Bosta returns already filtered to the admin date range.
  let bosta = await bostaReturnsForRange({ from, to });

  // If cache is empty for this range, do a short Bosta refresh scoped to those days.
  if (bosta.count === 0) {
    try {
      await Promise.race([
        syncBostaReturns({ from, to, maxPages: 15 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Bosta returns sync timeout')), 5000)),
      ]);
      bosta = await bostaReturnsForRange({ from, to });
    } catch (err) {
      logger.warn({ err }, 'Bosta returns range sync skipped');
    }
  }

  const orderIds = [...new Set(bosta.rows.map((r) => r.orderId).filter(Boolean).map(String))];
  const orders = orderIds.length
    ? await Order.find({ _id: { $in: orderIds } })
        .populate('customerId', 'fullName gender')
        .select('paymentMethod orderSource manualSource totalSellingPrice customerId shippingAddress')
        .lean()
    : [];
  const byId = Object.fromEntries(orders.map((o) => [String(o._id), o]));

  const payment = { cod: 0, online: 0 };
  const gender = { male: 0, female: 0, unknown: 0 };
  let amount = 0;

  for (const row of bosta.rows) {
    const order = row.orderId ? byId[String(row.orderId)] : null;
    if (order) {
      amount += order.totalSellingPrice || 0;
      const pay = order.paymentMethod === 'online' ? 'online' : 'cod';
      payment[pay] += 1;
      const name = order.customerId?.fullName || order.shippingAddress?.fullName || row.receiverName || '';
      const g = resolveGender(order.customerId?.gender, name);
      gender[g] = (gender[g] || 0) + 1;
    } else {
      amount += row.codAmount || 0;
      // Unlinked Bosta returns: treat positive COD as cash, else unknown bucket via gender only.
      if ((row.codAmount || 0) > 0) payment.cod += 1;
      else payment.cod += 1; // most Egypt RTOs / customer returns are COD channel
      gender.unknown += 1;
    }
  }

  // Fallback: warehouse confirms only (no Bosta sync yet)
  if (bosta.count === 0) {
    const history = await OrderStatusHistory.find({
      toStatus: 'returned_to_stock',
      createdAt: { $gte: from, $lte: to },
    })
      .select('orderId createdAt')
      .lean();
    const stockIds = [...new Set(history.map((h) => String(h.orderId)))];
    const stockOrders = await Order.find({ _id: { $in: stockIds } })
      .populate('customerId', 'fullName gender')
      .select('paymentMethod totalSellingPrice customerId shippingAddress')
      .lean();
    const stockById = Object.fromEntries(stockOrders.map((o) => [String(o._id), o]));
    for (const h of history) {
      const order = stockById[String(h.orderId)];
      if (!order) continue;
      amount += order.totalSellingPrice || 0;
      payment[order.paymentMethod === 'online' ? 'online' : 'cod'] += 1;
      const name = order.customerId?.fullName || order.shippingAddress?.fullName || '';
      const g = resolveGender(order.customerId?.gender, name);
      gender[g] = (gender[g] || 0) + 1;
    }
    const paymentMix = mixFromCounts(payment);
    const genderMix = mixFromCounts(gender);
    return {
      count: history.length,
      amount,
      source: 'warehouse',
      byType: null,
      payment: {
        ...paymentMix,
        cashPercent: paymentMix.cod?.percent ?? 0,
        onlinePercent: paymentMix.online?.percent ?? 0,
      },
      gender: {
        ...genderMix,
        malePercent: genderMix.male?.percent ?? 0,
        femalePercent: genderMix.female?.percent ?? 0,
        unknownPercent: genderMix.unknown?.percent ?? 0,
      },
    };
  }

  const paymentMix = mixFromCounts(payment);
  const genderMix = mixFromCounts(gender);

  return {
    count: bosta.count,
    amount,
    source: 'bosta',
    linkedCount: bosta.linkedCount,
    byType: bosta.byType,
    payment: {
      ...paymentMix,
      cashPercent: paymentMix.cod?.percent ?? 0,
      onlinePercent: paymentMix.online?.percent ?? 0,
    },
    gender: {
      ...genderMix,
      malePercent: genderMix.male?.percent ?? 0,
      femalePercent: genderMix.female?.percent ?? 0,
      unknownPercent: genderMix.unknown?.percent ?? 0,
    },
  };
}

/** Short in-memory cache so dashboard refreshes feel instant. */
const dashboardCache = new Map();
const DASHBOARD_CACHE_TTL_MS = 45_000;
const dashboardCoreCache = new Map();
const dashboardMoneyCache = new Map();
const dashboardSummaryCache = new Map();
const dashboardDetailsCache = new Map();

function dashboardCacheKey(query) {
  return JSON.stringify({
    preset: query?.preset || 'day',
    date: query?.date || '',
    from: query?.from || '',
    to: query?.to || '',
  });
}

function setBoundedCache(cache, key, data) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 40) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function ordersPlacedCutoff() {
  return new Date(`${ORDERS_PLACED_FROM_YMD}T00:00:00+03:00`);
}

async function warehouseReturnsSnapshot() {
  const cutoff = ordersPlacedCutoff();
  const openStatuses = ['returning_to_origin', 'returned_awaiting_receipt', 'back_from_local_shipping'];
  const [returningToOrigin, backAtBosta, backFromLocal, openExchanges] = await Promise.all([
    Order.countDocuments({ placedAt: { $gte: cutoff }, internalStatus: 'returning_to_origin' }),
    Order.countDocuments({ placedAt: { $gte: cutoff }, internalStatus: 'returned_awaiting_receipt' }),
    Order.countDocuments({ placedAt: { $gte: cutoff }, internalStatus: 'back_from_local_shipping' }),
    Order.countDocuments({
      placedAt: { $gte: cutoff },
      isExchangeOrder: true,
      internalStatus: { $in: openStatuses },
    }),
  ]);
  return {
    returningToOrigin,
    backAtBosta,
    backFromLocalShipping: backFromLocal,
    openTotal: returningToOrigin + backAtBosta + backFromLocal,
    openExchanges,
  };
}

async function warehouseConfirmsByKind({ from, to }) {
  const history = await OrderStatusHistory.find({
    toStatus: 'returned_to_stock',
    createdAt: { $gte: from, $lte: to },
  })
    .select('orderId')
    .lean();
  const ids = [...new Set(history.map((h) => String(h.orderId)))];
  const counts = { refused: 0, exchange: 0, refund: 0 };
  if (!ids.length) return { total: 0, ...counts };
  const orders = await Order.find({ _id: { $in: ids } })
    .select('isExchangeOrder isReturnOrder deliveredAt')
    .lean();
  for (const order of orders) {
    counts[classifyReturnKind(order)] += 1;
  }
  return { total: orders.length, ...counts };
}

async function buildDashboardCore(range, preset) {
  const orderRange = ordersMetricsRange(range);
  const emptyPayment = {
    totalCount: 0,
    totals: { revenueExclShipping: 0, revenueInclShipping: 0, shippingFeeTotal: 0 },
    cod: { count: 0, revenueExclShipping: 0, revenueInclShipping: 0, percentByCount: 0 },
    online: { count: 0, revenueExclShipping: 0, revenueInclShipping: 0, percentByCount: 0 },
  };

  const cutoff = ordersPlacedCutoff();
  const [ordersByStatus, deliveredLifetime, totalClosed, payment, warehouseReturns, deliveryPerformance, localShipping] =
    await Promise.all([
      Order.aggregate([
        { $match: { placedAt: { $gte: cutoff } } },
        { $group: { _id: '$internalStatus', count: { $sum: 1 } } },
      ]),
      Order.countDocuments({ internalStatus: 'delivered', placedAt: { $gte: cutoff } }),
      Order.countDocuments({ closedAt: { $exists: true }, placedAt: { $gte: cutoff } }),
      orderRange.empty ? Promise.resolve(emptyPayment) : paymentSplitForRange(orderRange),
      warehouseReturnsSnapshot(),
      orderRange.empty
        ? Promise.resolve({
            successRate: null,
            delivered: 0,
            failed: 0,
            refused: 0,
            attempted: 0,
            transit: { avgHours: null, medianHours: null, p90Hours: null, avgDays: null, medianDays: null, sampleSize: 0 },
          })
        : deliveryPerformanceForRange(orderRange),
      orderRange.empty
        ? Promise.resolve({ total: 0, delivered: 0, returned: 0, active: 0 })
        : Order.aggregate([
            {
              $match: {
                shippingMethod: 'local_shipping',
                placedAt: { $gte: orderRange.from, $lte: orderRange.to },
              },
            },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                delivered: {
                  $sum: { $cond: [{ $eq: ['$internalStatus', 'delivered'] }, 1, 0] },
                },
                returned: {
                  $sum: {
                    $cond: [
                      {
                        $in: [
                          '$internalStatus',
                          [
                            'returning_to_origin',
                            'returned_awaiting_receipt',
                            'returned_to_stock',
                            'back_from_local_shipping',
                          ],
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                active: {
                  $sum: {
                    $cond: [
                      {
                        $in: [
                          '$internalStatus',
                          [
                            'awaiting_bosta_pickup',
                            'picked_up_by_bosta',
                            'local_shipping',
                            'in_transit',
                          ],
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ]).then(([row]) => row || { total: 0, delivered: 0, returned: 0, active: 0 }),
    ]);

  const statusMap = Object.fromEntries(ordersByStatus.map((s) => [s._id, s.count]));
  const deliverySuccessRate =
    totalClosed > 0 ? Math.round((deliveredLifetime / totalClosed) * 100) : null;
  const revenueExclShipping = payment?.totals?.revenueExclShipping ?? 0;
  const ordersPlaced = payment?.totalCount ?? 0;

  return {
    ordersByStatus: statusMap,
    deliverySuccessRate,
    deliveryPerformance,
    deliveredCount: deliveredLifetime,
    totalClosed,
    range: {
      preset,
      from: range.from,
      to: range.to,
      fromYmd: range.fromYmd,
      toYmd: range.toYmd,
      timezone: BUSINESS_TZ,
      ordersFromYmd: orderRange.fromYmd,
      ordersToYmd: orderRange.toYmd,
    },
    payment,
    ordersPlaced,
    revenueToday: revenueExclShipping,
    revenueCustom: revenueExclShipping,
    warehouseReturns,
    localShipping,
  };
}

async function buildDashboardMoney(range) {
  const settled = await Promise.allSettled([
    paymobReceivedForRange(range),
    codCollectedForRange(range),
    codLeftToCollect(range),
    bostaReturnCountForRange(range),
    deliveredCountForRange(range),
    // Warehouse confirms split by kind — covers both Bosta AND local shipping returns
    warehouseConfirmsByKind(range),
  ]);

  const [
    paymobReceived,
    codCollected,
    leftToCollect,
    bostaReturns,
    deliveredInRange,
    warehouseByKind,
  ] = settled.map((r, idx) => {
    if (r.status === 'fulfilled') return r.value;
    logger.warn({ err: r.reason?.message || r.reason, idx }, 'Dashboard money provider failed');
    if (idx === 0) return { amount: 0, count: 0, source: 'paymob', real: false };
    if (idx === 1) return { amount: 0, count: 0, source: 'bosta_cod', real: false };
    if (idx === 2) return { amount: 0, count: 0, source: 'oms_open_cod_in_range', real: false };
    if (idx === 3) return { count: 0, accountCount: 0, amount: 0, linkedCount: 0, linkedRtoCount: 0, source: 'bosta' };
    if (idx === 4) return 0;
    return { total: 0, refund: 0, refused: 0, exchange: 0 };
  });

  const moneyCollected = await moneyCollectedVsExpectedForRange(range, {
    paymobReceived,
    codCollected,
  });

  // Refund count = warehouse-confirmed returns that are pure refunds or refused-at-door.
  // Excludes exchanges — they are tracked separately in the exchanges analytics page.
  // Uses warehouseConfirmsByKind which covers BOTH Bosta and local shipping channels.
  const refundCount = (warehouseByKind.refund ?? 0) + (warehouseByKind.refused ?? 0);
  const exchangeConfirmedCount = warehouseByKind.exchange ?? 0;
  const totalWarehouseConfirms = warehouseByKind.total ?? (refundCount + exchangeConfirmedCount);

  const returns = {
    amount: bostaReturns.amount ?? 0,
    count: totalWarehouseConfirms,
    refundCount,
    exchangeCount: exchangeConfirmedCount,
    bostaCount: bostaReturns.count ?? 0,
    accountCount: bostaReturns.accountCount ?? bostaReturns.count ?? 0,
    bostaAmount: bostaReturns.amount ?? 0,
    byType: {},
  };

  // Refund rate = confirmed refunds (not exchanges) ÷ delivered.
  const refundRate =
    deliveredInRange > 0 ? pct(refundCount, deliveredInRange) : null;

  // Legacy alias so existing consumers that read returnRate don't break.
  const returnRate = refundRate;

  return {
    paymobReceived,
    codCollected,
    leftToCollect,
    moneyCollected,
    returns,
    returnRate,
    refundRate,
    returnRateBasis: {
      refunds: refundCount,
      exchanges: exchangeConfirmedCount,
      warehouseTotal: totalWarehouseConfirms,
      orders: deliveredInRange,
      delivered: deliveredInRange,
      bostaLinked: bostaReturns.count ?? 0,
      source: 'warehouse_confirms',
      real: true,
    },
  };
}

async function buildDashboardSummary(range, preset) {
  const [core, money] = await Promise.all([
    buildDashboardCore(range, preset),
    buildDashboardMoney(range),
  ]);
  return { ...core, ...money };
}

async function buildDashboardDetails(range) {
  const orderRange = ordersMetricsRange(range);
  const emptyRange = Boolean(orderRange.empty);
  const settled = await Promise.allSettled([
    emptyRange ? Promise.resolve([]) : dailyBreakdownForRange(orderRange),
    emptyRange ? Promise.resolve([]) : topProductsForRange(orderRange),
    emptyRange
      ? Promise.resolve({
          payment: { codPercent: 0, onlinePercent: 0 },
          channel: { chatPercent: 0, onlineStorePercent: 0 },
        })
      : orderMixForRange(orderRange),
    returnsAnalyticsForRange(range),
    warehouseConfirmsByKind(range),
    emptyRange
      ? Promise.resolve({
          count: 0,
          amount: 0,
          gender: { total: 0 },
          reason: { total: 0 },
          daysAfterDelivery: { avg: null, median: null, sampleSize: 0, buckets: [] },
          rows: [],
        })
      : refundsDetailForRange(orderRange),
    emptyRange
      ? Promise.resolve({ exchangeOrderCount: 0, linesCollected: 0, topSkus: [], topSizes: [] })
      : exchangeSkuStatsForRange(orderRange),
  ]);

  const [dailyBreakdown, topProducts, orderMix, returnsAnalytics, warehouseByKind, refundsDetail, exchangeStats] =
    settled.map((r, idx) => {
      if (r.status === 'fulfilled') return r.value;
      logger.warn({ err: r.reason?.message || r.reason, idx }, 'Dashboard details provider failed');
      if (idx === 0) return [];
      if (idx === 1) return [];
      if (idx === 2)
        return { payment: { codPercent: 0, onlinePercent: 0 }, channel: { chatPercent: 0, onlineStorePercent: 0 } };
      if (idx === 3)
        return { count: 0, amount: 0, source: 'none', payment: { cod: { count: 0, percent: 0 }, online: { count: 0, percent: 0 } }, gender: { male: { count: 0, percent: 0 }, female: { count: 0, percent: 0 }, unknown: { count: 0, percent: 0 } }, byType: {} };
      if (idx === 4) return { total: 0, refused: 0, exchange: 0, refund: 0 };
      if (idx === 5)
        return { count: 0, amount: 0, gender: { total: 0 }, reason: { total: 0 }, daysAfterDelivery: { avg: null, median: null, sampleSize: 0, buckets: [] }, rows: [] };
      return { exchangeOrderCount: 0, linesCollected: 0, topSkus: [], topSizes: [] };
    });

  return {
    dailyBreakdown,
    orderMix,
    returnsAnalytics,
    warehouseByKind,
    refundsDetail,
    exchangeStats,
    returns: {
      amount: returnsAnalytics.amount ?? 0,
      count: returnsAnalytics.count ?? 0,
      bostaCount: returnsAnalytics.source === 'bosta' ? returnsAnalytics.count : 0,
      bostaAmount: returnsAnalytics.source === 'bosta' ? returnsAnalytics.amount : 0,
      byType: returnsAnalytics.byType,
    },
    productAnalytics: {
      topProducts: topProducts || [],
      range: { from: range.from, to: range.to },
    },
    employeeAnalytics: {
      employees: [],
      range: { from: range.from, to: range.to },
    },
  };
}

export async function getDashboardCore(query = {}) {
  const cacheKey = dashboardCacheKey(query);
  const cached = dashboardCoreCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DASHBOARD_CACHE_TTL_MS) {
    return cached.data;
  }

  const preset = query?.preset || 'day';
  const range = rangeForPreset({
    preset,
    date: query?.date,
    from: query?.from,
    to: query?.to,
  });

  const result = await buildDashboardCore(range, preset);
  setBoundedCache(dashboardCoreCache, cacheKey, result);
  return result;
}

export async function getDashboardMoney(query = {}) {
  const cacheKey = dashboardCacheKey(query);
  const cached = dashboardMoneyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DASHBOARD_CACHE_TTL_MS) {
    return cached.data;
  }

  const preset = query?.preset || 'day';
  const range = rangeForPreset({
    preset,
    date: query?.date,
    from: query?.from,
    to: query?.to,
  });

  const result = await buildDashboardMoney(range);
  setBoundedCache(dashboardMoneyCache, cacheKey, result);
  return result;
}

export async function getDashboardSummary(query = {}) {
  const cacheKey = dashboardCacheKey(query);
  const cached = dashboardSummaryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DASHBOARD_CACHE_TTL_MS) {
    return cached.data;
  }

  const preset = query?.preset || 'day';
  const range = rangeForPreset({
    preset,
    date: query?.date,
    from: query?.from,
    to: query?.to,
  });

  const result = await buildDashboardSummary(range, preset);
  setBoundedCache(dashboardSummaryCache, cacheKey, result);
  return result;
}

export async function getDashboardDetails(query = {}) {
  const cacheKey = dashboardCacheKey(query);
  const cached = dashboardDetailsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DASHBOARD_CACHE_TTL_MS) {
    return cached.data;
  }

  const preset = query?.preset || 'day';
  const range = rangeForPreset({
    preset,
    date: query?.date,
    from: query?.from,
    to: query?.to,
  });

  const result = await buildDashboardDetails(range, preset);
  setBoundedCache(dashboardDetailsCache, cacheKey, result);
  return result;
}

export async function getDashboardStats(query = {}) {
  const cacheKey = dashboardCacheKey(query);
  const cached = dashboardCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DASHBOARD_CACHE_TTL_MS) {
    return cached.data;
  }

  const preset = query?.preset || 'day';
  const range = rangeForPreset({
    preset,
    date: query?.date,
    from: query?.from,
    to: query?.to,
  });

  const [summary, details] = await Promise.all([
    buildDashboardSummary(range, preset),
    buildDashboardDetails(range),
  ]);
  const result = {
    ...summary,
    ...details,
    returns: {
      ...details.returns,
      gazelleCount: summary.returnRateBasis?.returns ?? 0,
    },
  };

  setBoundedCache(dashboardCache, cacheKey, result);

  return result;
}

export async function getProfitabilityReport({ from, to, groupBy = 'product' }) {
  const match = { internalStatus: 'delivered' };
  if (from || to) {
    match.deliveredAt = {};
    if (from) match.deliveredAt.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      if (String(to).length <= 10) end.setHours(23, 59, 59, 999);
      match.deliveredAt.$lte = end;
    }
  }

  const orders = await Order.find(match).select('items totalSellingPrice totalCogsSnapshot deliveredAt');

  const rows = [];
  for (const order of orders) {
    for (const item of order.items) {
      const revenue = item.unitSellingPrice * item.quantity;
      const cogs = (item.unitCogs || 0) * item.quantity;
      rows.push({
        sku: item.sku,
        variantId: item.variantId,
        revenue,
        cogs,
        margin: revenue - cogs,
        quantity: item.quantity,
        missingCogs: !item.unitCogs,
        deliveredAt: order.deliveredAt,
      });
    }
  }

  let products;
  if (groupBy === 'product') {
    const grouped = {};
    for (const row of rows) {
      const key = row.sku;
      if (!grouped[key]) {
        grouped[key] = {
          sku: key,
          revenue: 0,
          cogs: 0,
          margin: 0,
          quantity: 0,
          missingCogs: false,
        };
      }
      grouped[key].revenue += row.revenue;
      grouped[key].cogs += row.cogs;
      grouped[key].margin += row.margin;
      grouped[key].quantity += row.quantity;
      if (row.missingCogs) grouped[key].missingCogs = true;
    }
    products = Object.values(grouped).map((p) => ({
      ...p,
      marginPct: p.revenue > 0 ? (p.margin / p.revenue) * 100 : 0,
      decision:
        p.missingCogs
          ? 'Set COGS'
          : p.margin < 0
            ? 'Fix price/cost'
            : p.marginPct >= 40
              ? 'Scale'
              : p.marginPct < 20
                ? 'Improve margin'
                : 'Hold',
    }));
  } else {
    products = rows.map((p) => ({
      ...p,
      marginPct: p.revenue > 0 ? (p.margin / p.revenue) * 100 : 0,
    }));
  }

  products.sort((a, b) => b.margin - a.margin);

  const totals = products.reduce(
    (acc, p) => {
      acc.revenue += p.revenue;
      acc.cogs += p.cogs;
      acc.margin += p.margin;
      acc.quantity += p.quantity;
      if (p.missingCogs) acc.missingCogsSkus += 1;
      return acc;
    },
    { revenue: 0, cogs: 0, margin: 0, quantity: 0, missingCogsSkus: 0 }
  );
  totals.marginPct = totals.revenue > 0 ? (totals.margin / totals.revenue) * 100 : 0;

  const insights = [];
  if (!products.length) {
    insights.push({
      tone: 'warning',
      title: 'No delivered sales in range',
      detail: 'Widen dates or check fulfillment — profitability only counts delivered orders.',
    });
  } else {
    const best = products[0];
    const worst = products[products.length - 1];
    if (best) {
      insights.push({
        tone: 'success',
        title: `Best margin: ${best.sku}`,
        detail: `${best.marginPct.toFixed(0)}% · ${Math.round(best.margin).toLocaleString('en-EG')} EGP — prioritize restock.`,
      });
    }
    if (worst && worst.margin < best?.margin) {
      insights.push({
        tone: worst.margin < 0 ? 'danger' : 'warning',
        title: `Weakest: ${worst.sku}`,
        detail: `${worst.marginPct.toFixed(0)}% margin — ${worst.decision}.`,
      });
    }
    if (totals.missingCogsSkus > 0) {
      insights.push({
        tone: 'warning',
        title: `${totals.missingCogsSkus} SKUs missing COGS`,
        detail: 'Open COGS page and fill costs so margin decisions are trustworthy.',
      });
    }
    if (totals.marginPct >= 40) {
      insights.push({
        tone: 'success',
        title: `Portfolio margin ${totals.marginPct.toFixed(0)}%`,
        detail: 'Strong contribution — reinvest in winners, not across all SKUs equally.',
      });
    } else if (totals.marginPct < 25 && totals.revenue > 0) {
      insights.push({
        tone: 'danger',
        title: `Portfolio margin only ${totals.marginPct.toFixed(0)}%`,
        detail: 'Pause low-margin ads and renegotiate factory costs on bottom SKUs.',
      });
    }
  }

  return {
    from: from || null,
    to: to || null,
    totals,
    insights,
    products,
    // backward compatible array consumers
    data: products,
  };
}

export async function getAuditLog({ from, to, limit = 100, skip = 0 }) {
  const filter = {};
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }

  const [statusHistory, inventoryLedger] = await Promise.all([
    OrderStatusHistory.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    InventoryLedger.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
  ]);

  return { statusHistory, inventoryLedger };
}

export async function getTopSellersByUnits({ month, limit = 40 } = {}) {
  const BUSINESS_TZ = 'Africa/Cairo';
  const now = new Date();
  let y;
  let m;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    y = Number(month.slice(0, 4));
    m = Number(month.slice(5, 7));
  } else {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: BUSINESS_TZ,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(now);
    y = Number(parts.find((p) => p.type === 'year').value);
    m = Number(parts.find((p) => p.type === 'month').value);
  }

  const fromYmd = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const toYmd = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // Reuse Cairo day bounds from range helpers
  const from = (() => {
    const utc = Date.UTC(y, m - 1, 1, 0, 0, 0, 0);
    const asTz = new Date(utc).toLocaleString('en-US', { timeZone: BUSINESS_TZ });
    const asUtc = new Date(utc).toLocaleString('en-US', { timeZone: 'UTC' });
    return new Date(utc + (new Date(asUtc).getTime() - new Date(asTz).getTime()));
  })();
  const to = (() => {
    const utc = Date.UTC(y, m - 1, lastDay, 23, 59, 59, 999);
    const asTz = new Date(utc).toLocaleString('en-US', { timeZone: BUSINESS_TZ });
    const asUtc = new Date(utc).toLocaleString('en-US', { timeZone: 'UTC' });
    return new Date(utc + (new Date(asUtc).getTime() - new Date(asTz).getTime()));
  })();

  const rows = await Order.aggregate([
    {
      $match: {
        internalStatus: 'delivered',
        deliveredAt: { $gte: from, $lte: to },
      },
    },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.variantId',
        sku: { $first: '$items.sku' },
        unitsSold: { $sum: '$items.quantity' },
      },
    },
    { $sort: { unitsSold: -1 } },
    { $limit: Number(limit) || 40 },
  ]);

  const Variant = (await import('../models/Variant.js')).default;
  const variantIds = rows.map((r) => r._id).filter(Boolean);
  const variants = await Variant.find({ _id: { $in: variantIds } })
    .populate('productId', 'title imageUrl')
    .lean();
  const byId = Object.fromEntries(variants.map((v) => [String(v._id), v]));

  // Roll up to product level (pieces), keep best image/title
  const byProduct = new Map();
  for (const row of rows) {
    const v = byId[String(row._id)];
    const productId = v?.productId?._id ? String(v.productId._id) : String(row.sku);
    const title = v?.productId?.title || v?.title || row.sku;
    const imageUrl = v?.imageUrl || v?.productId?.imageUrl || '';
    const code = v?.sku || row.sku;
    const prev = byProduct.get(productId) || {
      productId,
      title,
      imageUrl,
      code,
      unitsSold: 0,
      skus: [],
    };
    prev.unitsSold += row.unitsSold;
    if (!prev.imageUrl && imageUrl) prev.imageUrl = imageUrl;
    if (code && !prev.skus.includes(code)) prev.skus.push(code);
    // Prefer product title; keep a representative code (first / most sold already ordered)
    if (!prev.code) prev.code = code;
    byProduct.set(productId, prev);
  }

  const products = [...byProduct.values()]
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, Number(limit) || 40)
    .map((p) => ({
      productId: p.productId,
      title: p.title,
      imageUrl: p.imageUrl,
      code: p.skus.length === 1 ? p.skus[0] : p.code,
      unitsSold: p.unitsSold,
    }));

  return {
    month: `${y}-${String(m).padStart(2, '0')}`,
    fromYmd,
    toYmd,
    products,
  };
}

export default {
  getDashboardStats,
  getDashboardCore,
  getDashboardMoney,
  getDashboardSummary,
  getDashboardDetails,
  getProfitabilityReport,
  getAuditLog,
  getTopSellersByUnits,
};
