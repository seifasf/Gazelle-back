import Order from '../models/Order.js';
import PaymobReceived from '../models/PaymobReceived.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import InventoryLedger from '../models/InventoryLedger.js';
import Employee from '../models/Employee.js';
import * as kpiService from './kpi.service.js';

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function nowDate() {
  return new Date();
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function rangeForPreset({ preset, date, from, to }) {
  const fromDate = parseDate(from);
  const toDate = parseDate(to);
  const dayDate = parseDate(date);

  if (preset === 'day' || preset === 'today') {
    const day = dayDate || startOfDay(nowDate());
    return { from: startOfDay(day), to: endOfDay(day) };
  }

  if (preset === 'custom') {
    return {
      from: fromDate ? startOfDay(fromDate) : startOfDay(new Date(nowDate().getTime() - 6 * 24 * 60 * 60 * 1000)),
      to: toDate ? endOfDay(toDate) : endOfDay(nowDate()),
    };
  }

  // Legacy presets (week/month) — map to custom windows for backward compatibility.
  if (preset === 'week') {
    const toD = nowDate();
    const start = new Date(toD);
    start.setDate(start.getDate() - 6);
    return { from: startOfDay(start), to: toD };
  }

  if (preset === 'month') {
    const toD = nowDate();
    const start = new Date(toD);
    start.setDate(start.getDate() - 29);
    return { from: startOfDay(start), to: toD };
  }

  return { from: startOfDay(nowDate()), to: endOfDay(nowDate()) };
}

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

async function dailyBreakdownForRange({ from, to }) {
  const [placedRows, paymobRows, codRows, returnRows] = await Promise.all([
    Order.aggregate([
      { $match: { placedAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$placedAt' } },
          revenueExclShipping: { $sum: '$totalSellingPrice' },
          orderCount: { $sum: 1 },
        },
      },
    ]),
    PaymobReceived.aggregate([
      { $match: { receivedAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$receivedAt' } },
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
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$bostaCollectedAt' } },
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
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          returnCount: { $sum: 1 },
          returnAmount: { $sum: { $ifNull: ['$order.totalSellingPrice', 0] } },
        },
      },
    ]),
  ]);

  const byDate = new Map();
  const ensure = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
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
    }
    return byDate.get(date);
  };

  for (const row of placedRows) ensure(row._id).revenueExclShipping = row.revenueExclShipping;
  for (const row of placedRows) ensure(row._id).orderCount = row.orderCount;
  for (const row of paymobRows) ensure(row._id).paymobReceived = row.paymobReceived;
  for (const row of paymobRows) ensure(row._id).paymobCount = row.paymobCount;
  for (const row of codRows) ensure(row._id).codCollected = row.codCollected;
  for (const row of codRows) ensure(row._id).codCount = row.codCount;
  for (const row of returnRows) ensure(row._id).returnCount = row.returnCount;
  for (const row of returnRows) ensure(row._id).returnAmount = row.returnAmount;

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
  ]);

  const statusMap = Object.fromEntries(ordersByStatus.map((s) => [s._id, s.count]));
  const deliverySuccessRate =
    totalClosed > 0 ? Math.round((deliveredCount / totalClosed) * 100) : null;

  const revenueExclShipping = payment?.totals?.revenueExclShipping ?? 0;

  return {
    ordersByStatus: statusMap,
    deliverySuccessRate,
    deliveredCount,
    totalClosed,
    range: {
      preset,
      from: range.from,
      to: range.to,
    },
    payment,
    paymobReceived,
    codCollected,
    leftToCollect,
    returns,
    dailyBreakdown,
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
