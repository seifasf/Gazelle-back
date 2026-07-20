import Order from '../models/Order.js';
import PaymobReceived from '../models/PaymobReceived.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import InventoryLedger from '../models/InventoryLedger.js';
import Employee from '../models/Employee.js';
import * as kpiService from './kpi.service.js';
import logger from '../utils/logger.js';

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
  // Prefer local ledger first (fast). Live Paymob API is optional and timed out.
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
    return { amount: row.amount ?? 0, count: row.count ?? 0, source: 'paymob_webhook' };
  }

  try {
    const { isPaymobApiConfigured, sumSuccessfulTransactions } = await import(
      '../integrations/paymob/transactions.service.js'
    );
    if (isPaymobApiConfigured()) {
      const live = await Promise.race([
        sumSuccessfulTransactions({ from, to }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Paymob API timeout')), 2500)),
      ]);
      return {
        amount: live.amount ?? 0,
        count: live.count ?? 0,
        source: 'paymob_api',
      };
    }
  } catch (err) {
    logger.warn({ err }, 'Paymob API sum skipped — using Shopify online fallback');
  }

  // Last resort: Shopify-marked online paid (until Paymob is configured).
  const [onlineRow] = await Order.aggregate([
    {
      $match: {
        paymentMethod: 'online',
        onlinePaymentStatus: 'paid',
        onlinePaidAt: { $gte: from, $lte: to },
      },
    },
    {
      $group: {
        _id: null,
        amount: {
          $sum: {
            $ifNull: [
              '$onlinePaymentAmount',
              { $add: [{ $ifNull: ['$totalSellingPrice', 0] }, { $ifNull: ['$shippingFee', 0] }] },
            ],
          },
        },
        count: { $sum: 1 },
      },
    },
  ]);
  return {
    amount: onlineRow?.amount ?? 0,
    count: onlineRow?.count ?? 0,
    source: 'shopify_online_fallback',
  };
}

async function codCollectedForRange({ from, to }) {
  // Prefer OMS stamps first — live Bosta paging is too slow for dashboard load.
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

  if ((bostaRow?.count || 0) > 0) {
    return { amount: bostaRow.amount ?? 0, count: bostaRow.count ?? 0, source: 'bosta' };
  }

  // Last resort: COD orders marked delivered in-range.
  const [deliveredRow] = await Order.aggregate([
    {
      $match: {
        $or: [{ paymentMethod: 'cod' }, { paymentMethod: { $exists: false } }, { paymentMethod: null }],
        deliveredAt: { $gte: from, $lte: to },
        internalStatus: 'delivered',
      },
    },
    {
      $group: {
        _id: null,
        amount: {
          $sum: {
            $add: [{ $ifNull: ['$totalSellingPrice', 0] }, { $ifNull: ['$shippingFee', 0] }],
          },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  return {
    amount: deliveredRow?.amount ?? 0,
    count: deliveredRow?.count ?? 0,
    source: 'delivered_fallback',
  };
}

async function codLeftToCollect() {
  const [row] = await Order.aggregate([
    {
      $match: {
        // Treat missing paymentMethod as COD (legacy Shopify imports).
        $or: [{ paymentMethod: 'cod' }, { paymentMethod: { $exists: false } }, { paymentMethod: null }],
        internalStatus: { $nin: ['cancelled', 'returned_to_stock'] },
      },
    },
    {
      $addFields: {
        // Do not reference other fields added in this same stage (Mongo may not resolve them).
        collected: { $ifNull: ['$bostaCollectedAmount', 0] },
        due: {
          $add: [{ $ifNull: ['$totalSellingPrice', 0] }, { $ifNull: ['$shippingFee', 0] }],
        },
      },
    },
    { $match: { $expr: { $lt: ['$collected', '$due'] } } },
    {
      $group: {
        _id: null,
        amount: { $sum: { $subtract: ['$due', '$collected'] } },
        count: { $sum: 1 },
      },
    },
  ]);
  return { amount: row?.amount ?? 0, count: row?.count ?? 0 };
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
  const { bostaReturnsForRange } = await import('../integrations/bosta/returns.service.js');

  const bosta = await bostaReturnsForRange({ from, to });
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

function dashboardCacheKey(query) {
  return JSON.stringify({
    preset: query?.preset || 'day',
    date: query?.date || '',
    from: query?.from || '',
    to: query?.to || '',
  });
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

  // Skip unused employee KPIs and live Bosta COD paging — keep dashboard on local DB.
  const [
    ordersByStatus,
    deliveredCount,
    totalClosed,
    payment,
    paymobReceived,
    codCollected,
    leftToCollect,
    dailyBreakdown,
    topProducts,
    orderMix,
    returnsAnalytics,
  ] = await Promise.all([
    Order.aggregate([{ $group: { _id: '$internalStatus', count: { $sum: 1 } } }]),
    Order.countDocuments({ internalStatus: 'delivered' }),
    Order.countDocuments({ closedAt: { $exists: true } }),
    paymentSplitForRange(range),
    paymobReceivedForRange(range),
    codCollectedForRange(range),
    codLeftToCollect(),
    dailyBreakdownForRange(range),
    topProductsForRange(range),
    orderMixForRange(range),
    returnsAnalyticsForRange(range),
  ]);

  const statusMap = Object.fromEntries(ordersByStatus.map((s) => [s._id, s.count]));
  const deliverySuccessRate =
    totalClosed > 0 ? Math.round((deliveredCount / totalClosed) * 100) : null;

  const revenueExclShipping = payment?.totals?.revenueExclShipping ?? 0;
  const ordersPlaced = payment?.totalCount ?? 0;
  const returns = {
    amount: returnsAnalytics.amount ?? 0,
    count: returnsAnalytics.count ?? 0,
    bostaCount: returnsAnalytics.source === 'bosta' ? returnsAnalytics.count : 0,
    bostaAmount: returnsAnalytics.source === 'bosta' ? returnsAnalytics.amount : 0,
    byType: returnsAnalytics.byType,
  };
  // Bosta returns are account-wide (often WooCommerce RTOs) and usually not linked to
  // Gazelle Shopify orders — don't present that as an order return-rate %.
  const returnRate =
    returnsAnalytics?.source === 'bosta' && !(returnsAnalytics.linkedCount > 0)
      ? null
      : ordersPlaced > 0
        ? pct(returnsAnalytics.count, ordersPlaced)
        : 0;

  const result = {
    ordersByStatus: statusMap,
    deliverySuccessRate,
    deliveredCount,
    totalClosed,
    range: {
      preset,
      from: range.from,
      to: range.to,
      fromYmd: range.fromYmd,
      toYmd: range.toYmd,
      timezone: BUSINESS_TZ,
    },
    payment,
    paymobReceived,
    codCollected,
    leftToCollect,
    returns,
    returnsAnalytics,
    orderMix,
    returnRate,
    dailyBreakdown,
    ordersPlaced,
    // Backward-compatible aliases
    revenueToday: revenueExclShipping,
    revenueCustom: revenueExclShipping,
    productAnalytics: {
      topProducts: topProducts || [],
      range: { from: range.from, to: range.to },
    },
    employeeAnalytics: {
      employees: [],
      range: { from: range.from, to: range.to },
    },
  };

  dashboardCache.set(cacheKey, { at: Date.now(), data: result });
  // Bound cache size
  if (dashboardCache.size > 40) {
    const oldest = dashboardCache.keys().next().value;
    dashboardCache.delete(oldest);
  }

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

export default { getDashboardStats, getProfitabilityReport, getAuditLog };
