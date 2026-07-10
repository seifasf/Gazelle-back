import Order from '../models/Order.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import Variant from '../models/Variant.js';
import Customer from '../models/Customer.js';
import { withTransaction } from '../utils/transaction.js';
import { assertTransition, isTerminalStatus } from './orderStateMachine.js';
import {
  applyLedgerEntries,
  buildHoldReserveEntries,
  buildDeliveryEntries,
  buildPreDeliveryReleaseEntries,
  buildPostDeliveryReturnEntries,
  buildManualAdjustmentEntry,
  buildStockIntakeEntries,
} from './inventory.service.js';
import { TERMINAL_ORDER_STATUSES, ORDER_STATUSES } from '../constants/index.js';
import { getAgenda } from '../config/agenda.js';
import { JOB_NAMES } from '../constants/index.js';
import {
  notifyOrderVerified,
  notifyFailedDelivery,
  notifyReturnToOrigin,
  notifyNewOrder,
  checkVariantsLowStock,
} from './notification.service.js';
import { recordDeliveryJournal } from './accounting.service.js';
import { recordCustomerCancellation } from './customer.service.js';

async function recordStatusChange(
  { orderId, fromStatus, toStatus, source, actorUserId, note },
  session
) {
  await OrderStatusHistory.create(
    [{ orderId, fromStatus, toStatus, source, actorUserId, note }],
    { session }
  );
}

async function transitionOrder(order, toStatus, meta, session) {
  const fromStatus = order.internalStatus;
  assertTransition(fromStatus, toStatus);

  const updates = {
    internalStatus: toStatus,
    lastStatusUpdateAt: new Date(),
  };

  if (toStatus === 'verified_ready_for_shipping') {
    updates.verifiedAt = new Date();
  }
  if (toStatus === 'delivered') {
    updates.deliveredAt = new Date();
    updates.closedAt = new Date();
  }
  if (TERMINAL_ORDER_STATUSES.includes(toStatus)) {
    updates.closedAt = new Date();
  }

  await Order.updateOne({ _id: order._id }, updates, { session });
  await recordStatusChange(
    {
      orderId: order._id,
      fromStatus,
      toStatus,
      source: meta.source,
      actorUserId: meta.actorUserId,
      note: meta.note,
    },
    session
  );

  return { fromStatus, toStatus };
}

async function enqueueShopifySync(ledgerDocs) {
  const pending = ledgerDocs.filter(
    (doc) => doc.ledgerType === 'online_stock_increment_api' && doc.shopifySyncStatus === 'pending'
  );
  if (pending.length === 0) return;

  try {
    const agenda = getAgenda();
    for (const doc of pending) {
      await agenda.now(JOB_NAMES.SHOPIFY_OUTBOUND_INVENTORY, { ledgerId: doc._id.toString() });
    }
  } catch {
    // Agenda may not be initialized in tests
  }
}

export async function verifyOrder(orderId, actorUserId, { outcome, note, totalCogsSnapshot, shippingMethod }) {
  const order = await Order.findById(orderId).populate('items.variantId');
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  if (outcome === 'customer_cancelled') {
    return cancelOrder(orderId, actorUserId, { reason: 'customer_changed_mind', note });
  }

  if (outcome !== 'confirmed') {
    order.verificationLog.push({ outcome, note, actorUserId });
    await order.save();
    return order;
  }

  const updates = { totalCogsSnapshot };
  if (!order.assignedOrdersManagerId) {
    updates.assignedOrdersManagerId = actorUserId;
  }

  const verified = await withTransaction(async (session) => {
    const fresh = await Order.findById(orderId).session(session);
    fresh.verificationLog.push({ outcome, note, actorUserId });
    if (totalCogsSnapshot != null) fresh.totalCogsSnapshot = totalCogsSnapshot;
    if (!fresh.assignedOrdersManagerId) fresh.assignedOrdersManagerId = actorUserId;
    if (shippingMethod) fresh.shippingMethod = shippingMethod;
    await fresh.save({ session });

    if (fresh.orderSource === 'manual') {
      await reserveStockForOrder(fresh._id, fresh.items, session);
    }

    await transitionOrder(
      fresh,
      'verified_ready_for_shipping',
      { source: 'user_action', actorUserId, note },
      session
    );
    return Order.findById(orderId).session(session);
  });

  await notifyOrderVerified(verified);
  return verified;
}

export async function cancelOrder(orderId, actorUserId, { reason, note, source = 'user_action' }) {
  return withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }
    if (isTerminalStatus(order.internalStatus)) {
      const err = new Error('Order already in terminal state');
      err.statusCode = 400;
      throw err;
    }

    const cancellable = ['pending_verification', 'verified_ready_for_shipping'];
    if (!cancellable.includes(order.internalStatus)) {
      const err = new Error('Order cannot be cancelled at this stage');
      err.statusCode = 400;
      throw err;
    }

    const ledgerEntries = buildPreDeliveryReleaseEntries(order._id, order.items);
    const ledgerDocs = await applyLedgerEntries(ledgerEntries, session);

    order.cancellationReason = reason;
    await order.save({ session });

    await transitionOrder(
      order,
      'cancelled',
      { source, actorUserId, note: note || reason },
      session
    );

    await recordCustomerCancellation(order.customerId, session);

    await enqueueShopifySync(ledgerDocs);
    return Order.findById(orderId).session(session);
  });
}

async function executeDelivered(order, { source, actorUserId, note }, session) {
  const ledgerEntries = buildDeliveryEntries(order._id, order.items);
  await applyLedgerEntries(ledgerEntries, session);
  await transitionOrder(order, 'delivered', { source, actorUserId, note }, session);
  await Customer.updateOne({ _id: order.customerId }, { $inc: { lifetimeDelivered: 1 } }, { session });
  const delivered = await Order.findById(order._id).session(session);
  // Best-effort accounting — must not block delivery.
  await recordDeliveryJournal(delivered, actorUserId);
  return delivered;
}

export async function markDelivered(orderId, source, actorUserId, note, existingSession) {
  const run = async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }
    return executeDelivered(order, { source, actorUserId, note }, session);
  };

  if (existingSession) return run(existingSession);
  const delivered = await withTransaction(run);
  // Delivery decrements warehouse stock — flag anything that dropped low.
  await checkVariantsLowStock((delivered?.items || []).map((i) => i.variantId));
  return delivered;
}

export async function confirmReturnedToStock(orderId, actorUserId, note) {
  return withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }

    assertTransition(order.internalStatus, 'returned_to_stock');

    // Post-delivery return vs RTO (never delivered)
    const ledgerDocs = await applyLedgerEntries(
      order.deliveredAt
        ? buildPostDeliveryReturnEntries(order._id, order.items)
        : buildPreDeliveryReleaseEntries(order._id, order.items),
      session
    );

    await transitionOrder(
      order,
      'returned_to_stock',
      { source: 'user_action', actorUserId, note },
      session
    );

    await Customer.updateOne(
      { _id: order.customerId },
      { $inc: { lifetimeRejectedOrReturned: 1 } },
      { session }
    );

    await enqueueShopifySync(ledgerDocs);
    return Order.findById(orderId).session(session);
  });
}

export async function transitionOrderStatus(orderId, toStatus, meta) {
  const updated = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }

    if (toStatus === 'delivered') {
      return executeDelivered(order, meta, session);
    }

    await transitionOrder(order, toStatus, meta, session);
    return Order.findById(orderId).session(session);
  });

  if (toStatus === 'failed_delivery') await notifyFailedDelivery(updated);
  else if (toStatus === 'returning_to_origin') await notifyReturnToOrigin(updated);
  else if (toStatus === 'delivered') await checkVariantsLowStock((updated?.items || []).map((i) => i.variantId));

  return updated;
}

export async function reserveStockForOrder(orderId, items, session) {
  const entries = buildHoldReserveEntries(orderId, items);
  return applyLedgerEntries(entries, session);
}

export async function manualStockAdjustment({ variantId, quantityDelta, reasonCode, actorUserId, syncToShopify = false }) {
  return withTransaction(async (session) => {
    const entries = syncToShopify && quantityDelta > 0
      ? buildStockIntakeEntries({ variantId, quantityDelta, reasonCode, actorUserId, syncToShopify: true })
      : [buildManualAdjustmentEntry({ variantId, quantityDelta, reasonCode, actorUserId })];
    const ledgerDocs = await applyLedgerEntries(entries, session);
    const variant = await Variant.findById(variantId).session(session);
    await enqueueShopifySync(ledgerDocs);
    return { variant, ledger: ledgerDocs[0], shopifySyncQueued: ledgerDocs.some((d) => d.shopifySyncStatus === 'pending') };
  }).then(async (result) => {
    await checkVariantsLowStock([variantId]);
    return result;
  });
}

export async function stockIntake({ variantId, quantity, reasonCode, note, actorUserId, syncToShopify = true }) {
  if (quantity <= 0) {
    const err = new Error('Stock intake quantity must be positive');
    err.statusCode = 400;
    throw err;
  }
  return manualStockAdjustment({
    variantId,
    quantityDelta: quantity,
    reasonCode: reasonCode || 'restock',
    actorUserId,
    syncToShopify,
  });
}

export async function createManualOrder({
  manualSource,
  shippingMethod,
  paymentMethod,
  shippingFee,
  customer,
  shippingAddress,
  items,
  totalSellingPrice,
  note,
  actorUserId,
  isCreatorOrder = false,
}) {
  const ref = `MAN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const manualOrder = await withTransaction(async (session) => {
    let customerDoc = await Customer.findOne({ phone: customer.phone }).session(session);
    if (!customerDoc) {
      [customerDoc] = await Customer.create(
        [{
          fullName: customer.fullName,
          phone: customer.phone,
          email: customer.email,
          riskFlag: customer.riskFlag || 'none',
        }],
        { session }
      );
    }

    const orderItems = [];
    for (const item of items) {
      const variant = await Variant.findById(item.variantId).session(session);
      if (!variant) {
        const err = new Error(`Variant not found: ${item.variantId}`);
        err.statusCode = 404;
        throw err;
      }
      orderItems.push({
        variantId: variant._id,
        sku: variant.sku,
        quantity: item.quantity,
        unitSellingPrice: item.unitSellingPrice ?? variant.sellingPrice,
        unitCogs: variant.cogs,
      });
    }

    const total = totalSellingPrice ?? orderItems.reduce(
      (sum, i) => sum + i.unitSellingPrice * i.quantity,
      0
    );

    const finalShippingAddress =
      shippingMethod === 'pickup'
        ? undefined
        : {
            ...(shippingAddress || {}),
            phone: shippingAddress?.phone || customer.phone,
            fullName: shippingAddress?.fullName || customer.fullName,
          };

    const [order] = await Order.create(
      [{
        shopifyOrderId: ref,
        orderSource: 'manual',
        manualSource,
        shippingMethod: shippingMethod || 'bosta',
        paymentMethod: paymentMethod || 'cod',
        shippingFee: shippingFee ?? 0,
        onlinePaymentReference: paymentMethod === 'online' ? ref : undefined,
        customerId: customerDoc._id,
        shippingAddress: finalShippingAddress,
        internalStatus: 'pending_verification',
        isCreatorOrder: Boolean(isCreatorOrder),
        totalSellingPrice: total,
        totalCogsSnapshot: orderItems.reduce((s, i) => s + (i.unitCogs || 0) * i.quantity, 0),
        items: orderItems,
        placedAt: new Date(),
        assignedOrdersManagerId: actorUserId,
        verificationLog: note ? [{ outcome: 'confirmed', note, actorUserId }] : [],
      }],
      { session }
    );

    await recordStatusChange(
      {
        orderId: order._id,
        fromStatus: null,
        toStatus: 'pending_verification',
        source: 'user_action',
        actorUserId,
        note: `Manual order from ${manualSource}`,
      },
      session
    );

    await Customer.updateOne({ _id: customerDoc._id }, { $inc: { lifetimeOrders: 1 } }, { session });

    return Order.findById(order._id).session(session).populate('customerId');
  });

  await notifyNewOrder(manualOrder, { source: 'manual' });
  return manualOrder;
}

export async function getOrderStateCounts() {
  const pipeline = [{ $group: { _id: '$internalStatus', count: { $sum: 1 } } }];
  const rows = await Order.aggregate(pipeline);
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const row of rows) {
    counts[row._id] = row.count;
  }
  counts.total = rows.reduce((sum, r) => sum + r.count, 0);
  return counts;
}

export async function listOrders({ status, search, orderSource, shippingMethod, limit = 50, skip = 0, sort = { placedAt: -1 } }) {
  const filter = {};
  if (status) {
    const statuses = typeof status === 'string' && status.includes(',')
      ? status.split(',').map((s) => s.trim())
      : status;
    filter.internalStatus = Array.isArray(statuses) ? { $in: statuses } : statuses;
  }
  if (orderSource) filter.orderSource = orderSource;
  if (shippingMethod) filter.shippingMethod = shippingMethod;
  if (search) {
    const regex = { $regex: search, $options: 'i' };
    filter.$or = [
      { shopifyOrderId: regex },
      { 'shippingAddress.fullName': regex },
      { 'shippingAddress.phone': regex },
      { 'shippingAddress.city': regex },
    ];
  }
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('customerId', 'fullName phone riskFlag lifetimeCancelled'),
    Order.countDocuments(filter),
  ]);
  return { orders, total };
}

export async function getOrderById(orderId) {
  return Order.findById(orderId)
    .populate('customerId')
    .populate('assignedOrdersManagerId', 'name email')
    .populate('assignedStockManagerId', 'name email')
    .populate('items.variantId', 'title color size imageUrl sku realStock onHoldStock');
}

export async function getOrderStatusHistory(orderId) {
  return OrderStatusHistory.find({ orderId }).sort({ createdAt: -1 });
}

export async function claimOrder(orderId, actorUserId, role) {
  const field = role === 'stock_manager' ? 'assignedStockManagerId' : 'assignedOrdersManagerId';
  return Order.findOneAndUpdate(
    { _id: orderId, [field]: { $in: [null, undefined] } },
    { [field]: actorUserId },
    { new: true }
  );
}

export default {
  verifyOrder,
  cancelOrder,
  markDelivered,
  confirmReturnedToStock,
  transitionOrderStatus,
  reserveStockForOrder,
  manualStockAdjustment,
  stockIntake,
  createManualOrder,
  getOrderStateCounts,
  getOrderById,
  listOrders,
  getOrderStatusHistory,
  claimOrder,
};
