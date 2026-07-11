import Order from '../models/Order.js';
import PaymobReceived from '../models/PaymobReceived.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import InventoryLedger from '../models/InventoryLedger.js';
import Employee from '../models/Employee.js';
import * as kpiService from './kpi.service.js';

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
  return { amount: row?.amount ?? 0, count: row?.count ?? 0 };
}

async function codCollectedForRange({ from, to }) {
  const [row] = await Order.aggregate([
    {
      $match: {
        paymentMethod: 'cod',
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
  return { amount: row?.amount ?? 0, count: row?.count ?? 0 };
}

async function codLeftToCollect() {
  const [row] = await Order.aggregate([
    {
      $match: {
        paymentMethod: 'cod',
        internalStatus: { $nin: ['cancelled', 'returned_to_stock'] },
      },
    },
    {
      $addFields: {
        shippingFeeSafe: { $ifNull: ['$shippingFee', 0] },
        collected: { $ifNull: ['$bostaCollectedAmount', 0] },
        due: { $add: ['$totalSellingPrice', '$shippingFeeSafe'] },
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
  const [row] = await OrderStatusHistory.aggregate([
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
  return { amount: row?.amount ?? 0, count: row?.count ?? 0 };
}

async function dailyBreakdownForRange({ from, to, fromYmd, toYmd }) {
  const [placedRows, paymobRows, codRows, returnRows] = await Promise.all([
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
  ]);

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

  const history = await OrderStatusHistory.find({
    toStatus: 'returned_to_stock',
    createdAt: { $gte: from, $lte: to },
  })
    .select('orderId createdAt')
    .lean();

  const orderIds = [...new Set(history.map((h) => String(h.orderId)))];
  const orders = await Order.find({ _id: { $in: orderIds } })
    .populate('customerId', 'fullName gender')
    .select('paymentMethod orderSource manualSource totalSellingPrice customerId shippingAddress')
    .lean();

  const byId = Object.fromEntries(orders.map((o) => [String(o._id), o]));

  const payment = { cod: 0, online: 0 };
  const gender = { male: 0, female: 0, unknown: 0 };
  let amount = 0;

  for (const h of history) {
    const order = byId[String(h.orderId)];
    if (!order) continue;
    amount += order.totalSellingPrice || 0;
    const pay = order.paymentMethod === 'online' ? 'online' : 'cod';
    payment[pay] += 1;

    const name = order.customerId?.fullName || order.shippingAddress?.fullName || '';
    const g = resolveGender(order.customerId?.gender, name);
    gender[g] = (gender[g] || 0) + 1;
  }

  const paymentMix = mixFromCounts(payment);
  const genderMix = mixFromCounts(gender);
  const total = history.length;

  return {
    count: total,
    amount,
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

export async function getDashboardStats(query = {}) {
  const preset = query?.preset || 'day';
  const range = rangeForPreset({
    preset,
    date: query?.date,
    from: query?.from,
    to: query?.to,
  });

  const [
    ordersByStatus,
    deliveredCount,
    totalClosed,
    payment,
    paymobReceived,
    codCollected,
    leftToCollect,
    returns,
    dailyBreakdown,
    topProducts,
    employeeKpis,
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
    returnsForRange(range),
    dailyBreakdownForRange(range),
    topProductsForRange(range),
    employeeKpisForRange(range),
    orderMixForRange(range),
    returnsAnalyticsForRange(range),
  ]);

  const statusMap = Object.fromEntries(ordersByStatus.map((s) => [s._id, s.count]));
  const deliverySuccessRate =
    totalClosed > 0 ? Math.round((deliveredCount / totalClosed) * 100) : null;

  const revenueExclShipping = payment?.totals?.revenueExclShipping ?? 0;
  const ordersPlaced = payment?.totalCount ?? 0;
  const returnRate = ordersPlaced > 0 ? pct(returnsAnalytics.count, ordersPlaced) : 0;

  return {
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
      employees: employeeKpis || [],
      range: { from: range.from, to: range.to },
    },
  };
}

export async function getProfitabilityReport({ from, to, groupBy = 'product' }) {
  const match = { internalStatus: 'delivered' };
  if (from || to) {
    match.deliveredAt = {};
    if (from) match.deliveredAt.$gte = new Date(from);
    if (to) match.deliveredAt.$lte = new Date(to);
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
        deliveredAt: order.deliveredAt,
      });
    }
  }

  if (groupBy === 'product') {
    const grouped = {};
    for (const row of rows) {
      const key = row.sku;
      if (!grouped[key]) grouped[key] = { sku: key, revenue: 0, cogs: 0, margin: 0, quantity: 0 };
      grouped[key].revenue += row.revenue;
      grouped[key].cogs += row.cogs;
      grouped[key].margin += row.margin;
      grouped[key].quantity += row.quantity;
    }
    return Object.values(grouped);
  }

  return rows;
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
