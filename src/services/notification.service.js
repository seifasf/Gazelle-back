import Notification from '../models/Notification.js';
import Variant from '../models/Variant.js';
import logger from '../utils/logger.js';

/**
 * Low-level create. Never throws — notifications are best-effort and must not
 * break the operational flow that triggered them.
 */
export async function createNotification({
  type,
  roles = [],
  title,
  body = '',
  severity = 'info',
  link,
  orderId,
  variantId,
}) {
  try {
    if (!roles.length || !title) return null;
    return await Notification.create({ type, roles, title, body, severity, link, orderId, variantId });
  } catch (err) {
    logger.warn({ err, type }, 'Failed to create notification');
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * High-level domain events
 * ------------------------------------------------------------------ */

export async function notifyNewOrder(order, { source } = {}) {
  const ref = order.shopifyOrderId || order._id;
  const channel = source === 'manual' ? 'Manual' : 'Shopify';
  return createNotification({
    type: 'new_order',
    roles: ['admin', 'orders_manager'],
    severity: 'info',
    title: `New order #${ref}`,
    body: `${channel} order from ${order.shippingAddress?.fullName || 'a customer'} · needs verification.`,
    link: `/orders/${order._id}`,
    orderId: order._id,
  });
}

export async function notifyOrderVerified(order) {
  return createNotification({
    type: 'order_verified',
    roles: ['admin', 'stock_manager'],
    severity: 'success',
    title: `Order #${order.shopifyOrderId || order._id} ready to ship`,
    body: 'Verified by Orders Manager — pick & pack when ready.',
    link: `/orders/${order._id}`,
    orderId: order._id,
  });
}

export async function notifyOrderCallbackDue(order) {
  const ref = order.bostaTrackingNumber || order.shopifyOrderId || order._id;
  return createNotification({
    type: 'order_callback_due',
    roles: ['admin', 'orders_manager'],
    severity: 'warning',
    title: `Call back #${ref}`,
    body: order.delayNote
      ? `Customer delay ends today. Note: ${order.delayNote}`
      : 'Customer asked to delay — call today to confirm and ready to ship.',
    link: `/orders/${order._id}`,
    orderId: order._id,
  });
}

export async function notifyFailedDelivery(order) {
  return createNotification({
    type: 'failed_delivery',
    roles: ['admin', 'orders_manager'],
    severity: 'danger',
    title: `Failed delivery — #${order.shopifyOrderId || order._id}`,
    body: 'Delivery attempt failed. Reschedule or return to origin.',
    link: `/orders/${order._id}`,
    orderId: order._id,
  });
}

export async function notifyReturnToOrigin(order) {
  return createNotification({
    type: 'return_to_origin',
    roles: ['admin', 'stock_manager'],
    severity: 'warning',
    title: `Return incoming — #${order.shopifyOrderId || order._id}`,
    body: 'Order is returning to origin. Confirm physical receipt when it arrives.',
    link: `/orders/${order._id}`,
    orderId: order._id,
  });
}

export async function notifyDiscrepancy(variant, { expected, actual } = {}) {
  return createNotification({
    type: 'discrepancy',
    roles: ['admin', 'stock_manager'],
    severity: 'warning',
    title: `Stock discrepancy — ${variant.sku}`,
    body: `Shopify reports ${actual} but OMS expected ${expected}. Review and reconcile.`,
    link: '/stock/discrepancies',
    variantId: variant._id,
  });
}

/**
 * Emit a low/out-of-stock notification for a variant if it has crossed its
 * threshold. De-duplicates against any recent unread alert for the same variant
 * so we don't spam on every decrement.
 */
export async function notifyLowStockIfNeeded(variantId) {
  try {
    const variant = await Variant.findById(variantId);
    if (!variant) return null;
    const threshold = variant.lowStockThreshold ?? 5;
    if (variant.realStock > threshold) return null;

    const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const existing = await Notification.findOne({
      variantId,
      type: { $in: ['low_stock', 'out_of_stock'] },
      createdAt: { $gte: since },
    });
    if (existing) return null;

    const out = variant.realStock <= 0;
    return createNotification({
      type: out ? 'out_of_stock' : 'low_stock',
      roles: ['admin', 'stock_manager'],
      severity: out ? 'danger' : 'warning',
      title: out ? `Out of stock — ${variant.sku}` : `Low stock — ${variant.sku}`,
      body: `${variant.title || variant.sku}: ${variant.realStock} left in warehouse (threshold ${threshold}).`,
      link: '/stock/low-stock',
      variantId: variant._id,
    });
  } catch (err) {
    logger.warn({ err, variantId }, 'Low-stock notification check failed');
    return null;
  }
}

export async function checkVariantsLowStock(variantIds = []) {
  const unique = [...new Set(variantIds.map((id) => String(id)))];
  for (const id of unique) {
    await notifyLowStockIfNeeded(id);
  }
}

/* ------------------------------------------------------------------ *
 * Reads / mutations for the in-app notification center
 * ------------------------------------------------------------------ */

export async function listForUser(user, { limit = 30, unreadOnly = false } = {}) {
  const filter = { roles: user.role };
  if (unreadOnly) filter.readBy = { $ne: user._id };
  const items = await Notification.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).lean();
  return items.map((n) => ({
    ...n,
    read: (n.readBy || []).some((id) => String(id) === String(user._id)),
    readBy: undefined,
  }));
}

export async function unreadCount(user) {
  return Notification.countDocuments({ roles: user.role, readBy: { $ne: user._id } });
}

export async function markRead(notificationId, user) {
  await Notification.updateOne(
    { _id: notificationId, roles: user.role },
    { $addToSet: { readBy: user._id } }
  );
  return unreadCount(user);
}

export async function markAllRead(user) {
  await Notification.updateMany(
    { roles: user.role, readBy: { $ne: user._id } },
    { $addToSet: { readBy: user._id } }
  );
  return 0;
}

export default {
  createNotification,
  notifyNewOrder,
  notifyOrderVerified,
  notifyOrderCallbackDue,
  notifyFailedDelivery,
  notifyReturnToOrigin,
  notifyDiscrepancy,
  notifyLowStockIfNeeded,
  checkVariantsLowStock,
  listForUser,
  unreadCount,
  markRead,
  markAllRead,
};
