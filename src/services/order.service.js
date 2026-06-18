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
} from './inventory.service.js';
import { TERMINAL_ORDER_STATUSES } from '../constants/index.js';
import { getAgenda } from '../config/agenda.js';
import { JOB_NAMES } from '../constants/index.js';

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

export async function verifyOrder(orderId, actorUserId, { outcome, note, totalCogsSnapshot }) {
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

  return withTransaction(async (session) => {
    const fresh = await Order.findById(orderId).session(session);
    fresh.verificationLog.push({ outcome, note, actorUserId });
    if (totalCogsSnapshot != null) fresh.totalCogsSnapshot = totalCogsSnapshot;
    if (!fresh.assignedOrdersManagerId) fresh.assignedOrdersManagerId = actorUserId;
    await fresh.save({ session });

    await transitionOrder(
      fresh,
      'verified_ready_for_shipping',
      { source: 'user_action', actorUserId, note },
      session
    );
    return Order.findById(orderId).session(session);
  });
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

    await Customer.updateOne({ _id: order.customerId }, { $inc: { lifetimeRejectedOrReturned: 1 } }, { session });

    await enqueueShopifySync(ledgerDocs);
    return Order.findById(orderId).session(session);
  });
}

async function executeDelivered(order, { source, actorUserId, note }, session) {
  const ledgerEntries = buildDeliveryEntries(order._id, order.items);
  await applyLedgerEntries(ledgerEntries, session);
  await transitionOrder(order, 'delivered', { source, actorUserId, note }, session);
  await Customer.updateOne({ _id: order.customerId }, { $inc: { lifetimeDelivered: 1 } }, { session });
  return Order.findById(order._id).session(session);
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
  return withTransaction(run);
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
  return withTransaction(async (session) => {
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
}

export async function reserveStockForOrder(orderId, items, session) {
  const entries = buildHoldReserveEntries(orderId, items);
  return applyLedgerEntries(entries, session);
}

export async function manualStockAdjustment({ variantId, quantityDelta, reasonCode, actorUserId }) {
  return withTransaction(async (session) => {
    const entry = buildManualAdjustmentEntry({ variantId, quantityDelta, reasonCode, actorUserId });
    const [ledgerDoc] = await applyLedgerEntries([entry], session);
    const variant = await Variant.findById(variantId).session(session);
    return { variant, ledger: ledgerDoc };
  });
}

export async function getOrderById(orderId) {
  return Order.findById(orderId)
    .populate('customerId')
    .populate('assignedOrdersManagerId', 'name email')
    .populate('assignedStockManagerId', 'name email');
}

export async function listOrders({ status, limit = 50, skip = 0, sort = { placedAt: 1 } }) {
  const filter = {};
  if (status) {
    filter.internalStatus = Array.isArray(status) ? { $in: status } : status;
  }
  const [orders, total] = await Promise.all([
    Order.find(filter).sort(sort).skip(skip).limit(limit).populate('customerId', 'fullName phone riskFlag'),
    Order.countDocuments(filter),
  ]);
  return { orders, total };
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
  getOrderById,
  listOrders,
  getOrderStatusHistory,
  claimOrder,
};
