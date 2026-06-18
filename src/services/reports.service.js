import Order from '../models/Order.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import InventoryLedger from '../models/InventoryLedger.js';

export async function getDashboardStats() {
  const [
    ordersByStatus,
    revenueToday,
    deliveredCount,
    totalClosed,
  ] = await Promise.all([
    Order.aggregate([{ $group: { _id: '$internalStatus', count: { $sum: 1 } } }]),
    Order.aggregate([
      {
        $match: {
          placedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      },
      { $group: { _id: null, total: { $sum: '$totalSellingPrice' } } },
    ]),
    Order.countDocuments({ internalStatus: 'delivered' }),
    Order.countDocuments({ closedAt: { $exists: true } }),
  ]);

  const statusMap = Object.fromEntries(ordersByStatus.map((s) => [s._id, s.count]));
  const deliverySuccessRate =
    totalClosed > 0 ? Math.round((deliveredCount / totalClosed) * 100) : null;

  return {
    ordersByStatus: statusMap,
    revenueToday: revenueToday[0]?.total || 0,
    deliverySuccessRate,
    deliveredCount,
    totalClosed,
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
