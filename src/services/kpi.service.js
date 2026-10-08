import OrderStatusHistory from '../models/OrderStatusHistory.js';
import InventoryLedger from '../models/InventoryLedger.js';
import DiscrepancyAlert from '../models/DiscrepancyAlert.js';
import Order from '../models/ReportOrder.js';
import User from '../models/User.js';
import { dateRangeFilter, rangeEnd, rangeStart } from '../utils/cairoTime.js';

function dateFilter(from, to) {
  const filter = {};
  if (from || to) {
    const range = dateRangeFilter(from, to);
    if (range) filter.createdAt = range;
  }
  return filter;
}

export async function getEmployeeKpis(userId, { from, to } = {}) {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  const filter = dateFilter(from, to);
  const base = { actorUserId: userId, ...filter };

  if (user.role === 'orders_manager') {
    const [verified, cancelled, totalHandled] = await Promise.all([
      OrderStatusHistory.countDocuments({
        ...base,
        toStatus: 'verified_ready_for_shipping',
      }),
      OrderStatusHistory.countDocuments({
        ...base,
        toStatus: 'cancelled',
      }),
      Order.countDocuments({
        assignedOrdersManagerId: userId,
        ...(from || to
          ? {
              placedAt: {
                ...(from ? { $gte: rangeStart(from) } : {}),
                ...(to ? { $lte: rangeEnd(to) } : {}),
              },
            }
          : {}),
      }),
    ]);

    const verifyEvents = await OrderStatusHistory.find({
      ...base,
      toStatus: 'verified_ready_for_shipping',
    })
      .select('orderId createdAt')
      .lean();

    let avgVerifyHours = null;
    if (verifyEvents.length) {
      const orderIds = verifyEvents.map((e) => e.orderId);
      const orders = await Order.find({ _id: { $in: orderIds } }).select('placedAt').lean();
      const placedMap = Object.fromEntries(orders.map((o) => [String(o._id), o.placedAt]));
      const hours = verifyEvents
        .map((e) => {
          const placed = placedMap[String(e.orderId)];
          if (!placed) return null;
          return (new Date(e.createdAt) - new Date(placed)) / (1000 * 60 * 60);
        })
        .filter((h) => h != null && h >= 0);
      if (hours.length) avgVerifyHours = hours.reduce((a, b) => a + b, 0) / hours.length;
    }

    return {
      role: user.role,
      ordersVerified: verified,
      ordersCancelled: cancelled,
      ordersAssigned: totalHandled,
      cancelRate: verified + cancelled > 0 ? (cancelled / (verified + cancelled)) * 100 : 0,
      avgVerificationHours: avgVerifyHours,
    };
  }

  if (user.role === 'stock_manager') {
    const [pickPacked, adjustments, discrepanciesResolved] = await Promise.all([
      OrderStatusHistory.countDocuments({
        ...base,
        toStatus: 'picked_up_by_bosta',
      }),
      InventoryLedger.countDocuments({
        actorUserId: userId,
        ledgerType: 'real_stock_increment_manual',
        ...filter,
      }),
      DiscrepancyAlert.countDocuments({
        resolvedByUserId: userId,
        ...(from || to
          ? {
              resolvedAt: {
                ...(from ? { $gte: rangeStart(from) } : {}),
                ...(to ? { $lte: rangeEnd(to) } : {}),
              },
            }
          : {}),
      }),
    ]);

    return {
      role: user.role,
      ordersPickPacked: pickPacked,
      stockAdjustments: adjustments,
      discrepanciesResolved,
    };
  }

  return {
    role: user.role,
    note: 'KPIs are defined for orders_manager and stock_manager roles',
  };
}

export default { getEmployeeKpis };
