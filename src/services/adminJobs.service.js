import Variant from '../models/Variant.js';
import Order from '../models/Order.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import Notification from '../models/Notification.js';
import { OPEN_PO_STATUSES } from '../constants/index.js';
import { createNotification } from './notification.service.js';
import logger from '../utils/logger.js';

/**
 * Nightly check: variants below threshold with no open factory PO.
 */
export async function checkRestockNeeded() {
  const lowVariants = await Variant.find({
    $expr: { $lte: ['$realStock', '$lowStockThreshold'] },
  }).select('sku title realStock lowStockThreshold');

  let notified = 0;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  for (const variant of lowVariants) {
    const openPo = await PurchaseOrder.findOne({
      status: { $in: OPEN_PO_STATUSES },
      'items.variantId': variant._id,
    });
    if (openPo) continue;

    const existing = await Notification.findOne({
      variantId: variant._id,
      type: { $in: ['low_stock', 'out_of_stock'] },
      createdAt: { $gte: since },
      title: { $regex: /restock/i },
    });
    if (existing) continue;

    await createNotification({
      type: variant.realStock <= 0 ? 'out_of_stock' : 'low_stock',
      roles: ['admin'],
      severity: variant.realStock <= 0 ? 'danger' : 'warning',
      title: `Restock needed — ${variant.sku}`,
      body: `${variant.title || variant.sku}: ${variant.realStock} in warehouse. No open factory PO — create one.`,
      link: '/admin/manufacturing/purchase-orders/new',
      variantId: variant._id,
    });
    notified += 1;
  }

  logger.info({ checked: lowVariants.length, notified }, 'Restock check complete');
  return { checked: lowVariants.length, notified };
}

/**
 * Daily check: variants with zero sales in the last 30 days.
 */
export async function checkSlowMovers() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const soldVariantIds = await Order.aggregate([
    { $match: { internalStatus: 'delivered', deliveredAt: { $gte: since } } },
    { $unwind: '$items' },
    { $group: { _id: '$items.variantId' } },
  ]);
  const soldSet = new Set(soldVariantIds.map((r) => String(r._id)));

  const activeVariants = await Variant.find({ realStock: { $gt: 0 } })
    .populate('productId', 'status title')
    .select('sku title realStock productId');

  let notified = 0;
  const notifSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  for (const variant of activeVariants) {
    if (variant.productId?.status !== 'active') continue;
    if (soldSet.has(String(variant._id))) continue;

    const existing = await Notification.findOne({
      variantId: variant._id,
      type: 'general',
      title: { $regex: /slow mover/i },
      createdAt: { $gte: notifSince },
    });
    if (existing) continue;

    await createNotification({
      type: 'general',
      roles: ['admin'],
      severity: 'warning',
      title: `Slow mover — ${variant.sku}`,
      body: `No sales in 30 days. ${variant.realStock} units in warehouse. Review pricing or promotion.`,
      link: '/admin/accounting/top-products',
      variantId: variant._id,
    });
    notified += 1;
  }

  logger.info({ checked: activeVariants.length, notified }, 'Slow-mover check complete');
  return { checked: activeVariants.length, notified };
}

export default { checkRestockNeeded, checkSlowMovers };
