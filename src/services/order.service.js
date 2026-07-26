import Order from '../models/Order.js';
import OrderStatusHistory from '../models/OrderStatusHistory.js';
import Variant from '../models/Variant.js';
import Customer from '../models/Customer.js';
import mongoose from 'mongoose';
import { withTransaction } from '../utils/transaction.js';
import { assertTransition, isTerminalStatus } from './orderStateMachine.js';
import {
  applyLedgerEntries,
  notifyNegativeStockCrossings,
  buildHoldReserveEntries,
  buildDeliveryEntries,
  buildPreDeliveryReleaseEntries,
  buildPostDeliveryReturnEntries,
  buildManualAdjustmentEntry,
  buildStockIntakeEntries,
} from './inventory.service.js';
import { TERMINAL_ORDER_STATUSES, ORDER_STATUSES, ORDERS_PLACED_FROM_YMD } from '../constants/index.js';
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
import logger from '../utils/logger.js';

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
  // Open-stock mode: OMS does not push inventory to Shopify (brand-owned).
  // Kept as a no-op-safe helper for any leftover pending online ledger rows.
  const pending = (ledgerDocs || []).filter(
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

async function afterLedgerApplied(ledgerDocs) {
  await notifyNegativeStockCrossings(ledgerDocs?._negativeCrossings || []);
  await enqueueShopifySync(ledgerDocs);
}

export async function verifyOrder(orderId, actorUserId, { outcome, note, totalCogsSnapshot, shippingMethod }) {
  const order = await Order.findById(orderId).populate('items.variantId');
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  const verifiable = ['pending_verification', 'no_response'];
  if (!verifiable.includes(order.internalStatus)) {
    const err = new Error('Order is not waiting for verification');
    err.statusCode = 400;
    throw err;
  }

  if (outcome === 'customer_cancelled') {
    const cancelNote = typeof note === 'string' ? note.trim() : '';
    if (!cancelNote) {
      const err = new Error('A cancellation note is required');
      err.statusCode = 400;
      throw err;
    }
    return cancelOrder(orderId, actorUserId, { reason: 'customer_changed_mind', note: cancelNote });
  }

  if (outcome === 'no_response') {
    const updated = await withTransaction(async (session) => {
      const fresh = await Order.findById(orderId).session(session);
      fresh.verificationLog.push({ outcome, note, actorUserId });
      if (!fresh.assignedOrdersManagerId) fresh.assignedOrdersManagerId = actorUserId;
      await fresh.save({ session });
      if (fresh.internalStatus !== 'no_response') {
        await transitionOrder(
          fresh,
          'no_response',
          {
            source: 'user_action',
            actorUserId,
            note: note || 'Customer did not respond',
          },
          session
        );
      }
      return Order.findById(orderId).session(session);
    });
    return updated;
  }

  if (outcome !== 'confirmed') {
    // e.g. customer_requested_changes — log only, stay in current queue state.
    order.verificationLog.push({ outcome, note, actorUserId });
    await order.save();
    return order;
  }

  const verified = await withTransaction(async (session) => {
    const fresh = await Order.findById(orderId).session(session);
    fresh.verificationLog.push({ outcome, note, actorUserId });
    if (totalCogsSnapshot != null) fresh.totalCogsSnapshot = totalCogsSnapshot;
    if (!fresh.assignedOrdersManagerId) fresh.assignedOrdersManagerId = actorUserId;
    if (shippingMethod) fresh.shippingMethod = shippingMethod;
    fresh.delayedUntil = undefined;
    fresh.delayNote = undefined;
    fresh.delayNotifiedOn = undefined;
    await fresh.save({ session });
    await Order.updateOne(
      { _id: fresh._id },
      { $unset: { delayedUntil: 1, delayNote: 1, delayNotifiedOn: 1 } },
      { session }
    );

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
  const cancelNote = typeof note === 'string' ? note.trim() : '';
  // Shopify-originated cancels already have context; staff cancels need an explicit note.
  if (source !== 'shopify_webhook' && !cancelNote) {
    const err = new Error('A cancellation note is required');
    err.statusCode = 400;
    throw err;
  }

  let newlyCancelled = false;
  const cancelled = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }
    if (isTerminalStatus(order.internalStatus)) {
      if (order.internalStatus === 'cancelled') {
        return Order.findById(orderId).session(session);
      }
      const err = new Error('Order already in terminal state');
      err.statusCode = 400;
      throw err;
    }

    const cancellable = [
      'pending_verification',
      'no_response',
      'verified_ready_for_shipping',
      'out_of_stock',
    ];
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
      { source, actorUserId, note: cancelNote || reason },
      session
    );

    await recordCustomerCancellation(order.customerId, session);

    newlyCancelled = true;
    return { order: await Order.findById(orderId).session(session), ledgerDocs };
  });

  await afterLedgerApplied(cancelled?.ledgerDocs);

  const cancelledOrder = cancelled?.order || cancelled;

  // Cancel on Shopify after OMS commit (skip when Shopify already cancelled / manual orders).
  if (
    newlyCancelled &&
    source !== 'shopify_webhook' &&
    cancelledOrder?.orderSource === 'shopify' &&
    cancelledOrder?.shopifyOrderId
  ) {
    try {
      const { cancelShopifyOrder } = await import('../integrations/shopify/mutations/orderCancel.js');
      await cancelShopifyOrder({
        shopifyOrderId: cancelledOrder.shopifyOrderId,
        reason,
        staffNote: cancelNote || reason,
        notifyCustomer: false,
        refund: cancelledOrder.paymentMethod === 'online',
      });
    } catch (err) {
      // OMS cancel already succeeded — surface Shopify failure without rolling back.
      const logger = (await import('../utils/logger.js')).default;
      logger.error(
        { err: err?.message || err, orderId: String(cancelledOrder._id), shopifyOrderId: cancelledOrder.shopifyOrderId },
        'Failed to cancel order on Shopify after OMS cancel'
      );
      cancelledOrder.shopifyCancelWarning = err?.message || 'Failed to cancel on Shopify';
    }
  }

  return cancelledOrder;
}

async function executeDelivered(order, { source, actorUserId, note }, session) {
  const ledgerEntries = buildDeliveryEntries(order._id, order.items);
  let ledgerDocs = [];
  try {
    ledgerDocs = await applyLedgerEntries(ledgerEntries, session);
  } catch (err) {
    // Historical Shopify imports / Bosta backfill often never reserved hold stock.
    // Still mark delivered so COD + courier status stay truthful; log the inventory gap.
    if (source === 'bosta_webhook' || source === 'shopify_import') {
      const logger = (await import('../utils/logger.js')).default;
      logger.warn(
        { err: err.message, orderId: order._id, source },
        'Delivery stock ledger skipped (insufficient stock) — status still applied'
      );
    } else {
      throw err;
    }
  }
  await transitionOrder(order, 'delivered', { source, actorUserId, note }, session);
  await Customer.updateOne({ _id: order.customerId }, { $inc: { lifetimeDelivered: 1 } }, { session });
  const delivered = await Order.findById(order._id).session(session);
  // Best-effort accounting — must not block delivery.
  await recordDeliveryJournal(delivered, actorUserId);
  delivered._ledgerDocs = ledgerDocs;
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
  await afterLedgerApplied(delivered?._ledgerDocs);
  // Delivery decrements warehouse stock — flag anything that dropped low / negative.
  await checkVariantsLowStock((delivered?.items || []).map((i) => i.variantId));
  return delivered;
}

export async function confirmReturnedToStock(orderId, actorUserId, note) {
  const result = await withTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }

    const confirmable = ['returned_awaiting_receipt', 'returning_to_origin'];
    if (!confirmable.includes(order.internalStatus)) {
      const err = new Error('Only returning / Back at Bosta orders can be confirmed into warehouse stock');
      err.statusCode = 400;
      throw err;
    }

    // Post-delivery return / customer return pickup: increment warehouse stock.
    // Pre-delivery RTO (never delivered): release hold only.
    const ledgerDocs = await applyLedgerEntries(
      order.isReturnOrder || order.deliveredAt
        ? buildPostDeliveryReturnEntries(order._id, order.items)
        : buildPreDeliveryReleaseEntries(order._id, order.items),
      session
    );

    await transitionOrder(
      order,
      'returned_to_stock',
      {
        source: 'user_action',
        actorUserId,
        note: note || 'Physical receipt confirmed — returned to warehouse stock',
      },
      session
    );

    await Customer.updateOne(
      { _id: order.customerId },
      { $inc: { lifetimeRejectedOrReturned: 1 } },
      { session }
    );

    return { order: await Order.findById(orderId).session(session), ledgerDocs };
  });

  await afterLedgerApplied(result.ledgerDocs);
  // Post-delivery returns add real stock — may unblock Out of stock orders.
  if (result.order?.deliveredAt) {
    const variantIds = (result.order.items || []).map((i) => i.variantId).filter(Boolean);
    await releaseOutOfStockOrdersIfRestocked(variantIds, {
      actorUserId,
      note: 'Auto: return restocked SKUs — back to Ready to ship',
    });
  }
  return result.order;
}

/**
 * After warehouse stock increases, move Out of stock orders back to Ready to ship
 * when every line item now has enough realStock.
 */
export async function releaseOutOfStockOrdersIfRestocked(
  variantIds,
  { actorUserId = null, note } = {}
) {
  const ids = [
    ...new Set(
      (variantIds || [])
        .map((id) => String(id || '').trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ];
  if (!ids.length) return { released: [], checked: 0 };

  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  const candidates = await Order.find({
    internalStatus: 'out_of_stock',
    'items.variantId': { $in: objectIds },
  })
    .sort({ verifiedAt: 1, placedAt: 1 })
    .select('_id items sku shopifyOrderName');

  if (!candidates.length) return { released: [], checked: 0 };

  const neededVariantIds = [
    ...new Set(
      candidates.flatMap((o) => (o.items || []).map((i) => String(i.variantId))).filter(Boolean)
    ),
  ];
  const variants = await Variant.find({ _id: { $in: neededVariantIds } }).select('realStock sku');
  const stockById = new Map(variants.map((v) => [String(v._id), v.realStock ?? 0]));

  const released = [];
  const releaseNote =
    note || 'Auto: stock restocked — back to Ready to ship';

  for (const order of candidates) {
    const lines = order.items || [];
    if (!lines.length) continue;
    const fullyStocked = lines.every((item) => {
      const have = stockById.get(String(item.variantId));
      if (have == null) return false;
      return have >= (item.quantity || 0);
    });
    if (!fullyStocked) continue;

    try {
      await transitionOrderStatus(order._id, 'verified_ready_for_shipping', {
        source: 'system',
        actorUserId,
        note: releaseNote,
      });
      released.push(String(order._id));
    } catch (err) {
      logger.warn(
        { err: err?.message || err, orderId: String(order._id) },
        'Failed to auto-release out_of_stock order after restock'
      );
    }
  }

  if (released.length) {
    logger.info(
      { released: released.length, variantIds: ids },
      'Auto-released out_of_stock orders after restock'
    );
  }

  return { released, checked: candidates.length };
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

  if (toStatus === 'delivered') {
    await afterLedgerApplied(updated?._ledgerDocs);
  }
  if (toStatus === 'verified_ready_for_shipping') await notifyOrderVerified(updated);
  else if (toStatus === 'failed_delivery') await notifyFailedDelivery(updated);
  else if (toStatus === 'returned_awaiting_receipt' || toStatus === 'returning_to_origin') {
    await notifyReturnToOrigin(updated);
  } else if (toStatus === 'delivered') {
    await checkVariantsLowStock((updated?.items || []).map((i) => i.variantId));
  }

  return updated;
}

export async function reserveStockForOrder(orderId, items, session) {
  const entries = buildHoldReserveEntries(orderId, items);
  return applyLedgerEntries(entries, session);
}

export async function manualStockAdjustment({
  variantId,
  quantityDelta,
  reasonCode,
  actorUserId,
  skipOosAutoRelease = false,
}) {
  const result = await withTransaction(async (session) => {
    const entries = buildStockIntakeEntries({
      variantId,
      quantityDelta,
      reasonCode,
      actorUserId,
    });
    const ledgerDocs = await applyLedgerEntries(entries, session);
    const variant = await Variant.findById(variantId).session(session);
    return { variant, ledger: ledgerDocs[0], ledgerDocs, shopifySyncQueued: false };
  });
  await afterLedgerApplied(result.ledgerDocs);
  await checkVariantsLowStock([variantId]);
  if (!skipOosAutoRelease && quantityDelta > 0) {
    result.oosReleased = await releaseOutOfStockOrdersIfRestocked([variantId], {
      actorUserId,
      note: 'Auto: stock intake restocked SKUs — back to Ready to ship',
    });
  }
  return result;
}

export async function stockIntake({
  variantId,
  quantity,
  reasonCode,
  note,
  actorUserId,
  skipOosAutoRelease = false,
}) {
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
    skipOosAutoRelease,
  });
}

/**
 * Set absolute warehouse realStock for many variants (open-stock count / Excel import).
 * Never writes to Shopify.
 */
export async function setRealStockBatch({ items, reasonCode = 'stock_count', actorUserId }) {
  if (!Array.isArray(items) || !items.length) {
    const err = new Error('items array is required');
    err.statusCode = 400;
    throw err;
  }

  const results = [];
  const allCrossings = [];

  for (const item of items) {
    const variantId = item.variantId;
    const target = Number(item.realStock ?? item.target ?? item.quantity);
    if (!variantId || !Number.isFinite(target)) continue;

    const outcome = await withTransaction(async (session) => {
      const variant = await Variant.findById(variantId).session(session);
      if (!variant) {
        const err = new Error(`Variant not found: ${variantId}`);
        err.statusCode = 404;
        throw err;
      }
      const current = variant.realStock ?? 0;
      const delta = target - current;
      if (delta === 0) {
        return { variantId, sku: variant.sku, previous: current, realStock: current, changed: false };
      }
      const ledgerDocs = await applyLedgerEntries(
        [
          buildManualAdjustmentEntry({
            variantId,
            quantityDelta: delta,
            reasonCode,
            actorUserId,
          }),
        ],
        session
      );
      const updated = await Variant.findById(variantId).session(session);
      return {
        variantId,
        sku: updated.sku,
        previous: current,
        realStock: updated.realStock,
        changed: true,
        ledgerDocs,
      };
    });

    if (outcome.ledgerDocs?._negativeCrossings?.length) {
      allCrossings.push(...outcome.ledgerDocs._negativeCrossings);
    }
    results.push({
      variantId: outcome.variantId,
      sku: outcome.sku,
      previous: outcome.previous,
      realStock: outcome.realStock,
      changed: outcome.changed,
    });
  }

  await notifyNegativeStockCrossings(allCrossings);
  await checkVariantsLowStock(results.map((r) => r.variantId));

  const increasedIds = results
    .filter((r) => r.changed && r.realStock > r.previous)
    .map((r) => r.variantId);
  let oosReleased = { released: [], checked: 0 };
  if (increasedIds.length) {
    oosReleased = await releaseOutOfStockOrdersIfRestocked(increasedIds, {
      actorUserId,
      note: 'Auto: stock count restocked SKUs — back to Ready to ship',
    });
  }

  if (!results.length) {
    const err = new Error('No valid stock set rows');
    err.statusCode = 400;
    throw err;
  }

  return { results, count: results.length, oosReleased };
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
  isExchangeOrder = false,
  exchangeFromOrderId = null,
  isReturnOrder = false,
  returnFromOrderId = null,
  bostaReturnItems = null,
}) {
  const ref = `MAN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const exchange = Boolean(isExchangeOrder);
  const customerReturn = Boolean(isReturnOrder);

  if (exchange && customerReturn) {
    const err = new Error('Choose either Exchange or Return — not both');
    err.statusCode = 400;
    throw err;
  }

  if (exchange && !exchangeFromOrderId) {
    const err = new Error('Select the previous order this exchange replaces');
    err.statusCode = 400;
    throw err;
  }

  if (customerReturn && !returnFromOrderId) {
    const err = new Error('Select the previous order this return is for');
    err.statusCode = 400;
    throw err;
  }

  if (exchange && (!Array.isArray(bostaReturnItems) || bostaReturnItems.length < 1)) {
    const err = new Error('Select the items to collect from the customer for this exchange');
    err.statusCode = 400;
    throw err;
  }

  if (
    customerReturn &&
    (!Array.isArray(bostaReturnItems) || bostaReturnItems.length < 1) &&
    (!Array.isArray(items) || items.length < 1)
  ) {
    const err = new Error('Select the items to pick up for this return');
    err.statusCode = 400;
    throw err;
  }

  const manualOrder = await withTransaction(async (session) => {
    let priorOrder = null;
    const priorId = exchange ? exchangeFromOrderId : customerReturn ? returnFromOrderId : null;
    if (priorId) {
      priorOrder = await Order.findById(priorId).session(session);
      if (!priorOrder) {
        const err = new Error('Previous order not found');
        err.statusCode = 404;
        throw err;
      }
    }

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
    } else {
      // Keep customer profile current so name/phone search stays accurate.
      const patch = {};
      if (customer.fullName && customer.fullName !== customerDoc.fullName) patch.fullName = customer.fullName;
      if (customer.email && customer.email !== customerDoc.email) patch.email = customer.email;
      if (Object.keys(patch).length) {
        Object.assign(customerDoc, patch);
        await customerDoc.save({ session });
      }
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
        unitSellingPrice: exchange || customerReturn ? 0 : (item.unitSellingPrice ?? variant.sellingPrice),
        unitCogs: variant.cogs,
      });
    }

    const total = exchange || customerReturn
      ? 0
      : totalSellingPrice ?? orderItems.reduce(
          (sum, i) => sum + i.unitSellingPrice * i.quantity,
          0
        );

    // Exchange: items free, customer pays shipping by place (from Shopify prior order).
    // Return pickup: no COD / no shipping collect — courier must not give cash to customer.
    const feeRaw = shippingFee != null ? Number(shippingFee) : null;
    const exchangeShippingFee =
      feeRaw != null && Number.isFinite(feeRaw) && feeRaw >= 0
        ? feeRaw
        : Number(priorOrder?.shippingFee) || 0;
    const finalShippingFee = customerReturn
      ? 0
      : exchange
        ? exchangeShippingFee
        : (shippingFee ?? 0);

    const finalShippingAddress =
      shippingMethod === 'pickup'
        ? undefined
        : {
            ...(shippingAddress || {}),
            phone: shippingAddress?.phone || customer.phone,
            fullName: shippingAddress?.fullName || customer.fullName,
          };

    const priorLabel = priorOrder
      ? priorOrder.shopifyOrderName || priorOrder.shopifyOrderId || priorOrder._id
      : null;
    const linkNote = exchange
      ? `Exchange for ${priorLabel}`
      : customerReturn
        ? `Return pickup for ${priorLabel}`
        : null;

    const method = shippingMethod || 'bosta';
    const isPickup = method === 'pickup' && !exchange && !customerReturn;
    const now = new Date();

    // Manual orders skip call-center verify:
    // - normal / exchange / local / bosta → Ready to ship
    // - customer pickup → Delivered immediately
    // - refund / return → Returning to Warehouse (track inbound)
    let initialStatus = 'verified_ready_for_shipping';
    if (customerReturn) initialStatus = 'returning_to_origin';
    else if (isPickup) initialStatus = 'delivered';

    const normalizedReturnItems = Array.isArray(bostaReturnItems) && bostaReturnItems.length
      ? bostaReturnItems.map((r) => ({
          variantId: r.variantId,
          sku: r.sku,
          quantity: r.quantity || 1,
          title: r.title,
          color: r.color,
          size: r.size,
        }))
      : customerReturn
        ? orderItems.map((i) => ({
            variantId: i.variantId,
            sku: i.sku,
            quantity: i.quantity,
          }))
        : [];

    const [order] = await Order.create(
      [{
        shopifyOrderId: ref,
        orderSource: 'manual',
        manualSource,
        shippingMethod: method,
        paymentMethod: customerReturn ? 'cod' : (paymentMethod || 'cod'),
        shippingFee: finalShippingFee,
        onlinePaymentReference: paymentMethod === 'online' && !customerReturn ? ref : undefined,
        customerId: customerDoc._id,
        shippingAddress: finalShippingAddress,
        internalStatus: initialStatus,
        verifiedAt: now,
        deliveredAt: isPickup ? now : undefined,
        closedAt: isPickup ? now : undefined,
        isCreatorOrder: exchange || customerReturn ? false : Boolean(isCreatorOrder),
        isExchangeOrder: exchange,
        exchangeFromOrderId: exchange ? priorOrder._id : undefined,
        isReturnOrder: customerReturn,
        returnFromOrderId: customerReturn ? priorOrder._id : undefined,
        bostaReturnItems: normalizedReturnItems,
        totalSellingPrice: total,
        totalCogsSnapshot: orderItems.reduce((s, i) => s + (i.unitCogs || 0) * i.quantity, 0),
        items: orderItems,
        placedAt: now,
        assignedOrdersManagerId: actorUserId,
        verificationLog: [
          ...(note ? [{ outcome: 'confirmed', note, actorUserId }] : []),
          ...(linkNote
            ? [{ outcome: 'confirmed', note: linkNote, actorUserId }]
            : []),
          {
            outcome: 'confirmed',
            note: customerReturn
              ? 'Return / refund auto-verified · Returning to Warehouse · Bosta CRP · COD 0'
              : isPickup
                ? 'Pickup auto-verified · marked Delivered'
                : exchange
                  ? `Exchange auto-verified · Ready to ship · shipping EGP ${finalShippingFee} · Bosta EXCHANGE`
                  : 'Manual order auto-verified · Ready to ship',
            actorUserId,
          },
        ],
      }],
      { session }
    );

    let deliveryLedgerDocs = null;

    if (customerReturn) {
      // Inbound only — no warehouse hold. Stock increments when confirmed in warehouse.
    } else if (isPickup) {
      await reserveStockForOrder(order._id, orderItems, session);
      deliveryLedgerDocs = await applyLedgerEntries(
        buildDeliveryEntries(order._id, orderItems),
        session
      );
      await Customer.updateOne(
        { _id: customerDoc._id },
        { $inc: { lifetimeDelivered: 1 } },
        { session }
      );
    } else {
      // Ready to ship (normal, creator, exchange, local shipping, Bosta).
      await reserveStockForOrder(order._id, orderItems, session);
    }

    await recordStatusChange(
      {
        orderId: order._id,
        fromStatus: null,
        toStatus: initialStatus,
        source: 'user_action',
        actorUserId,
        note: customerReturn
          ? `Return pickup from ${manualSource} (for ${priorLabel}) · Returning to Warehouse · COD 0`
          : isPickup
            ? `Pickup from ${manualSource} · Delivered`
            : exchange
              ? `Exchange from ${manualSource} (for ${priorLabel}) · Ready to ship · shipping EGP ${finalShippingFee}`
              : `Manual order from ${manualSource} · Ready to ship`,
      },
      session
    );

    await Customer.updateOne({ _id: customerDoc._id }, { $inc: { lifetimeOrders: 1 } }, { session });

    const populated = await Order.findById(order._id)
      .session(session)
      .populate('customerId')
      .populate('exchangeFromOrderId', 'shopifyOrderId shopifyOrderName internalStatus shippingFee')
      .populate('returnFromOrderId', 'shopifyOrderId shopifyOrderName internalStatus shippingFee')
      .populate('items.variantId', 'title color size imageUrl sku realStock onHoldStock');

    if (deliveryLedgerDocs) populated._ledgerDocs = deliveryLedgerDocs;
    return populated;
  });

  if (manualOrder?._ledgerDocs) {
    await afterLedgerApplied(manualOrder._ledgerDocs);
    await checkVariantsLowStock((manualOrder.items || []).map((i) => i.variantId?._id || i.variantId));
    try {
      await recordDeliveryJournal(manualOrder, actorUserId);
    } catch {
      /* non-blocking */
    }
  }

  await notifyNewOrder(manualOrder, { source: 'manual' });
  if (!manualOrder.isReturnOrder && manualOrder.internalStatus === 'verified_ready_for_shipping') {
    try {
      await notifyOrderVerified(manualOrder);
    } catch {
      /* non-blocking */
    }
  }
  return manualOrder;
}

/**
 * Resolve a prior order for exchange by Shopify name/id (#43897 / 43897).
 * Only searches orders placed in the last 2 months (keeps lookup light).
 */
export async function findOrderForExchange(query) {
  const raw = String(query || '').trim();
  if (!raw) {
    const err = new Error('Enter a Shopify order number');
    err.statusCode = 400;
    throw err;
  }

  const withHash = raw.startsWith('#') ? raw : `#${raw.replace(/^#/, '')}`;
  const digits = raw.replace(/\D/g, '');
  const since = new Date();
  since.setMonth(since.getMonth() - 2);

  const or = [
    { shopifyOrderName: withHash },
    { shopifyOrderName: raw },
  ];
  if (digits) {
    or.push({ shopifyOrderId: digits });
    or.push({ shopifyOrderName: `#${digits}` });
  }
  // Manual refs / Mongo id fallback
  if (/^[a-f\d]{24}$/i.test(raw)) or.push({ _id: raw });
  or.push({ shopifyOrderId: raw });

  const order = await Order.findOne({
    $or: or,
    placedAt: { $gte: since },
  })
    .sort({ placedAt: -1 })
    .populate('customerId', 'fullName phone email')
    .populate('items.variantId', 'title color size imageUrl sku sellingPrice productId')
    .lean();

  if (!order) {
    const err = new Error(
      `Order not found for ${withHash} in the last 2 months. Older orders are not searchable.`
    );
    err.statusCode = 404;
    throw err;
  }

  return order;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ordersPlacedFromCutoff() {
  // Cairo midnight for ORDERS_PLACED_FROM_YMD (Egypt is UTC+2 / +3 — use +03:00 bound).
  const ymd = ORDERS_PLACED_FROM_YMD;
  return new Date(`${ymd}T00:00:00+03:00`);
}

export async function getOrderStateCounts() {
  const cutoff = ordersPlacedFromCutoff();
  const pipeline = [
    { $match: { placedAt: { $gte: cutoff } } },
    { $group: { _id: '$internalStatus', count: { $sum: 1 } } },
  ];
  const rows = await Order.aggregate(pipeline);
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const row of rows) {
    counts[row._id] = row.count;
  }
  counts.total = rows.reduce((sum, r) => sum + r.count, 0);

  // Fulfillment queue excludes customer pickup (handled on the order page).
  const [fulfillmentReady, pickupReady] = await Promise.all([
    Order.countDocuments({
      placedAt: { $gte: cutoff },
      internalStatus: 'verified_ready_for_shipping',
      shippingMethod: { $ne: 'pickup' },
    }),
    Order.countDocuments({
      placedAt: { $gte: cutoff },
      internalStatus: 'verified_ready_for_shipping',
      shippingMethod: 'pickup',
    }),
  ]);
  counts.fulfillment_ready = fulfillmentReady;
  counts.pickup_ready = pickupReady;

  return counts;
}

export async function listOrders({
  status,
  search,
  orderSource,
  shippingMethod,
  isExchangeOrder,
  isReturnOrder,
  limit = 50,
  skip = 0,
  sort = { placedAt: -1 },
}) {
  const filter = {
    // Hide pre-cutover orders from queues / lists; money KPIs still use full ranges.
    placedAt: { $gte: ordersPlacedFromCutoff() },
  };
  if (status) {
    const statuses = typeof status === 'string' && status.includes(',')
      ? status.split(',').map((s) => s.trim())
      : status;
    filter.internalStatus = Array.isArray(statuses) ? { $in: statuses } : statuses;
  }
  if (orderSource) filter.orderSource = orderSource;
  if (shippingMethod) filter.shippingMethod = shippingMethod;
  if (isExchangeOrder === true || isExchangeOrder === 'true') filter.isExchangeOrder = true;
  if (isReturnOrder === true || isReturnOrder === 'true') filter.isReturnOrder = true;
  if (search) {
    const term = String(search).trim();
    if (term) {
      const regex = { $regex: escapeRegex(term), $options: 'i' };
      // Match customer name/phone/email too — UI shows customerId.fullName,
      // and pickup/manual orders often have no searchable shippingAddress.
      const matchingCustomers = await Customer.find({
        $or: [
          { fullName: regex },
          { phone: regex },
          { email: regex },
        ],
      })
        .select('_id')
        .lean();
      const customerIds = matchingCustomers.map((c) => c._id);

      filter.$or = [
        { shopifyOrderId: regex },
        { bostaTrackingNumber: regex },
        { bostaDeliveryId: regex },
        { 'shippingAddress.fullName': regex },
        { 'shippingAddress.phone': regex },
        { 'shippingAddress.city': regex },
        ...(customerIds.length ? [{ customerId: { $in: customerIds } }] : []),
      ];
      // Allow searching with a leading # (UI shows Shopify as #123…).
      const digits = term.replace(/^#/, '').trim();
      if (digits && digits !== term) {
        const digitsRegex = { $regex: escapeRegex(digits), $options: 'i' };
        filter.$or.push(
          { shopifyOrderId: digitsRegex },
          { bostaTrackingNumber: digitsRegex },
          { bostaDeliveryId: digitsRegex }
        );
      }
    }
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
    .populate({
      path: 'items.variantId',
      select: 'title color size imageUrl sku realStock onHoldStock productId',
      populate: { path: 'productId', select: 'title imageUrl' },
    });
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

/**
 * Customer asked to delay — stay in pending_verification until callback day.
 * @param {string} delayedUntil - YYYY-MM-DD (Cairo business day)
 */
export async function delayOrder(orderId, actorUserId, { delayedUntil, note }) {
  const order = await Order.findById(orderId);
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }
  if (order.internalStatus !== 'pending_verification' && order.internalStatus !== 'no_response') {
    const err = new Error('Only pending verification / no-response orders can be delayed');
    err.statusCode = 400;
    throw err;
  }

  const ymd = String(delayedUntil || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    const err = new Error('delayedUntil must be YYYY-MM-DD');
    err.statusCode = 400;
    throw err;
  }

  // Store as noon UTC-ish for the Cairo calendar day via Egypt offset approximation:
  // Use start-of-day Cairo by constructing ISO with +03:00 (EET/EEST approx; fine for date-only).
  const until = new Date(`${ymd}T12:00:00+03:00`);
  if (Number.isNaN(until.getTime())) {
    const err = new Error('Invalid delay date');
    err.statusCode = 400;
    throw err;
  }

  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  if (ymd < todayYmd) {
    const err = new Error('Delay date must be today or later');
    err.statusCode = 400;
    throw err;
  }

  order.delayedUntil = until;
  order.delayNote = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  order.delayNotifiedOn = undefined;
  if (!order.assignedOrdersManagerId) order.assignedOrdersManagerId = actorUserId;
  order.verificationLog.push({
    outcome: 'no_response',
    note: `Delayed until ${ymd}${order.delayNote ? ` — ${order.delayNote}` : ''}`,
    actorUserId,
  });
  await order.save();
  return order;
}

/**
 * Daily job: notify OM for delays due today (Cairo).
 */
export async function processDelayCallbacksDue() {
  const { notifyOrderCallbackDue } = await import('./notification.service.js');
  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const dayStart = new Date(`${todayYmd}T00:00:00+03:00`);
  const dayEnd = new Date(`${todayYmd}T23:59:59.999+03:00`);

  const due = await Order.find({
    internalStatus: { $in: ['pending_verification', 'no_response'] },
    delayedUntil: { $gte: dayStart, $lte: dayEnd },
    $or: [{ delayNotifiedOn: { $exists: false } }, { delayNotifiedOn: null }, { delayNotifiedOn: { $ne: todayYmd } }],
  }).limit(200);

  let notified = 0;
  for (const order of due) {
    await notifyOrderCallbackDue(order);
    order.delayNotifiedOn = todayYmd;
    await order.save();
    notified += 1;
  }
  return { date: todayYmd, notified };
}

const DISCOUNT_PERCENTS = [5, 10, 15, 20, 25, 30];
const DISCOUNTABLE_STATUSES = [
  'pending_verification',
  'no_response',
  'verified_ready_for_shipping',
  'out_of_stock',
];

/**
 * Apply % discount on merchandise (totalSellingPrice), never on shippingFee.
 * percent 0 clears the discount and restores merchandiseSubtotal.
 */
export async function applyOrderDiscount(orderId, actorUserId, { percent }) {
  const order = await Order.findById(orderId);
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  if (!DISCOUNTABLE_STATUSES.includes(order.internalStatus)) {
    const err = new Error('Discount can only be set before the order is handed to courier');
    err.statusCode = 400;
    throw err;
  }

  if (order.bostaDeliveryId || ['queued', 'creating', 'created'].includes(order.bostaShipmentStatus)) {
    const err = new Error('Cannot change discount after a Bosta shipment was created');
    err.statusCode = 400;
    throw err;
  }

  if (order.isExchangeOrder || order.isCreatorOrder || order.isReturnOrder) {
    const err = new Error('Discount is not available on exchange / creator / return orders');
    err.statusCode = 400;
    throw err;
  }

  const pct = Number(percent);
  if (!Number.isFinite(pct) || pct < 0) {
    const err = new Error('Invalid discount percent');
    err.statusCode = 400;
    throw err;
  }
  if (pct !== 0 && !DISCOUNT_PERCENTS.includes(pct)) {
    const err = new Error(`Discount must be one of: ${DISCOUNT_PERCENTS.join(', ')}% (or 0 to clear)`);
    err.statusCode = 400;
    throw err;
  }

  const base =
    order.merchandiseSubtotal != null && order.merchandiseSubtotal > 0
      ? Number(order.merchandiseSubtotal)
      : Number(order.totalSellingPrice || 0) + Number(order.discountAmount || 0);

  if (!(base > 0) && pct > 0) {
    const err = new Error('Order has no merchandise total to discount');
    err.statusCode = 400;
    throw err;
  }

  const discountAmount = pct === 0 ? 0 : Math.round((base * pct) / 100 * 100) / 100;
  const totalSellingPrice = Math.max(0, Math.round((base - discountAmount) * 100) / 100);

  order.merchandiseSubtotal = base;
  order.discountPercent = pct;
  order.discountAmount = discountAmount;
  order.totalSellingPrice = totalSellingPrice;
  await order.save();

  await OrderStatusHistory.create({
    orderId: order._id,
    fromStatus: order.internalStatus,
    toStatus: order.internalStatus,
    source: 'user_action',
    actorUserId,
    note:
      pct === 0
        ? `Cleared merchandise discount — total ${totalSellingPrice} EGP (shipping unchanged)`
        : `Applied ${pct}% discount on merchandise (−${discountAmount} EGP) — goods ${totalSellingPrice} EGP + shipping ${order.shippingFee || 0} EGP`,
  });

  return order;
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
  setRealStockBatch,
  releaseOutOfStockOrdersIfRestocked,
  createManualOrder,
  findOrderForExchange,
  getOrderStateCounts,
  getOrderById,
  listOrders,
  getOrderStatusHistory,
  claimOrder,
  delayOrder,
  processDelayCallbacksDue,
  applyOrderDiscount,
};
