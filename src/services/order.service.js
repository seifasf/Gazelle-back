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
  buildDeliveryStockEntries,
  buildMissingHoldEntries,
  buildPreDeliveryReleaseEntries,
  buildPostDeliveryReturnEntries,
  buildManualAdjustmentEntry,
  buildStockIntakeEntries,
} from './inventory.service.js';
import {
  TERMINAL_ORDER_STATUSES,
  ORDER_STATUSES,
  ORDERS_PLACED_FROM_YMD,
  LOCAL_SHIPPING_FEE,
  DEFAULT_BOSTA_SHIPPING_FEE,
  JOB_NAMES,
} from '../constants/index.js';
import { getAgenda } from '../config/agenda.js';
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

  const $set = {
    internalStatus: toStatus,
    lastStatusUpdateAt: new Date(),
  };
  const $unset = {};

  if (toStatus === 'verified_ready_for_shipping') {
    $set.verifiedAt = new Date();
    if (fromStatus === 'out_of_stock') {
      $set.returnedFromOutOfStockAt = new Date();
    }
  }
  if (
    fromStatus === 'verified_ready_for_shipping'
    && toStatus !== 'verified_ready_for_shipping'
  ) {
    $unset.returnedFromOutOfStockAt = 1;
  }
  if (toStatus === 'delivered') {
    $set.deliveredAt = new Date();
    $set.closedAt = new Date();
  }
  if (TERMINAL_ORDER_STATUSES.includes(toStatus)) {
    $set.closedAt = new Date();
  }

  const mongoUpdate = { $set };
  if (Object.keys($unset).length) mongoUpdate.$unset = $unset;

  await Order.updateOne({ _id: order._id }, mongoUpdate, { session });
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
  const docs = Array.isArray(ledgerDocs) ? ledgerDocs : [];
  const variantIds = [
    ...new Set(
      docs
        .map((d) => (d?.variantId != null ? String(d.variantId) : null))
        .filter(Boolean)
    ),
  ];
  if (!variantIds.length) return;

  // Prefer immediate sync so returns / deliveries update Shopify without waiting on Agenda.
  const { syncVariantAvailableToShopify } = await import(
    '../integrations/shopify/pushWarehouseStock.service.js'
  );
  const { getShopifyWritePolicy } = await import('../integrations/shopify/writePolicy.js');
  const policy = await getShopifyWritePolicy();
  if (policy !== 'full') return;

  for (const variantId of variantIds) {
    try {
      await syncVariantAvailableToShopify(variantId);
    } catch (err) {
      logger.warn(
        { err: err?.message || err, variantId },
        'Immediate Shopify stock sync failed — queueing retry'
      );
      try {
        const agenda = getAgenda();
        await agenda.now(JOB_NAMES.SHOPIFY_OUTBOUND_INVENTORY, { variantId });
      } catch {
        // Agenda may not be initialized in scripts/tests
      }
    }
  }
}

async function afterLedgerApplied(ledgerDocs) {
  await notifyNegativeStockCrossings(ledgerDocs?._negativeCrossings || []);
  await enqueueShopifySync(ledgerDocs);
}

/** Public: push Shopify sellable (real − hold) after hold/real ledger commits. */
export async function syncShopifySellableAfterLedger(ledgerDocs) {
  return afterLedgerApplied(ledgerDocs);
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
    if (shippingMethod) {
      fresh.shippingMethod = shippingMethod;
      if (shippingMethod === 'local_shipping') {
        fresh.shippingFee = LOCAL_SHIPPING_FEE;
      } else if (shippingMethod === 'pickup') {
        fresh.shippingFee = 0;
      }
    }
    fresh.delayedUntil = undefined;
    fresh.delayNote = undefined;
    fresh.delayNotifiedOn = undefined;
    await fresh.save({ session });
    await Order.updateOne(
      { _id: fresh._id },
      { $unset: { delayedUntil: 1, delayNote: 1, delayNotifiedOn: 1 } },
      { session }
    );

    let ledgerDocs = [];
    if (fresh.orderSource === 'manual') {
      ledgerDocs = await reserveStockForOrder(fresh._id, fresh.items, session);
    } else {
      // Shopify already reserves at ingest — top up if hold is missing.
      ledgerDocs = await ensureOrderStockHeld(fresh._id, fresh.items, session);
    }

    await transitionOrder(
      fresh,
      'verified_ready_for_shipping',
      { source: 'user_action', actorUserId, note },
      session
    );
    const updated = await Order.findById(orderId).session(session);
    updated._ledgerDocs = ledgerDocs;
    return updated;
  });

  await afterLedgerApplied(verified?._ledgerDocs);
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
      'local_shipping',
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
  // Release remaining hold for this order + always decrement warehouse stock.
  const ledgerEntries = await buildDeliveryStockEntries(order._id, order.items, session);
  let ledgerDocs = [];
  try {
    if (ledgerEntries.length) {
      ledgerDocs = await applyLedgerEntries(ledgerEntries, session);
    }
  } catch (err) {
    // Historical imports / courier backfill: still mark delivered; log inventory gap.
    if (source === 'bosta_webhook' || source === 'shopify_import') {
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

    /**
     * What physically arrives at the warehouse:
     * - Exchange (delivered): COLLECT lines (bostaReturnItems) — outbound already sold on deliver
     * - Exchange (never delivered): outbound package came back — release hold only
     * - Refund CRP: pickup lines (bostaReturnItems or items) → +real stock
     * - Post-delivery RTO: order.items → +real stock
     * - Pre-delivery refused: release hold on order.items only
     */
    const collectLines =
      Array.isArray(order.bostaReturnItems) && order.bostaReturnItems.length > 0
        ? order.bostaReturnItems
        : order.items;

    let ledgerEntries;
    let restockVariantIds = [];
    let confirmNote;

    if (order.isExchangeOrder && order.deliveredAt) {
      if (!collectLines?.length) {
        const err = new Error('Exchange has no collect items to restock — check bostaReturnItems');
        err.statusCode = 400;
        throw err;
      }
      ledgerEntries = buildPostDeliveryReturnEntries(order._id, collectLines);
      restockVariantIds = collectLines.map((i) => i.variantId).filter(Boolean);
      confirmNote =
        note ||
        `Exchange collect received — restocked ${collectLines
          .map((i) => `${i.sku}×${i.quantity}`)
          .join(', ')}`;
    } else if (order.isExchangeOrder) {
      // Failed exchange / customer refused — outbound never sold; free the hold.
      ledgerEntries = buildPreDeliveryReleaseEntries(order._id, order.items);
      confirmNote =
        note ||
        `Exchange not delivered — released hold on ${(order.items || [])
          .map((i) => `${i.sku}×${i.quantity}`)
          .join(', ')}`;
    } else if (order.isReturnOrder) {
      ledgerEntries = buildPostDeliveryReturnEntries(order._id, collectLines);
      restockVariantIds = collectLines.map((i) => i.variantId).filter(Boolean);
      confirmNote =
        note ||
        `Refund pickup received — restocked ${(collectLines || [])
          .map((i) => `${i.sku}×${i.quantity}`)
          .join(', ')}`;
    } else if (order.deliveredAt) {
      ledgerEntries = buildPostDeliveryReturnEntries(order._id, order.items);
      restockVariantIds = (order.items || []).map((i) => i.variantId).filter(Boolean);
      confirmNote = note || 'Physical receipt confirmed — returned to warehouse stock';
    } else {
      // Customer refused / failed delivery before sell — free the hold, do not +1 real stock.
      ledgerEntries = buildPreDeliveryReleaseEntries(order._id, order.items);
      confirmNote = note || 'Physical receipt confirmed — hold released (never delivered)';
    }

    const ledgerDocs = await applyLedgerEntries(ledgerEntries, session);

    await transitionOrder(
      order,
      'returned_to_stock',
      {
        source: 'user_action',
        actorUserId,
        note: confirmNote,
      },
      session
    );

    await Customer.updateOne(
      { _id: order.customerId },
      { $inc: { lifetimeRejectedOrReturned: 1 } },
      { session }
    );

    return {
      order: await Order.findById(orderId).session(session),
      ledgerDocs,
      restockVariantIds,
    };
  });

  await afterLedgerApplied(result.ledgerDocs);

  // Restock (exchange collect / refund / post-delivery return) may unblock Out of stock orders.
  if (result.restockVariantIds?.length) {
    await releaseOutOfStockOrdersIfRestocked(result.restockVariantIds, {
      actorUserId,
      note: 'Auto: return/exchange restocked SKUs — back to Ready to ship',
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
      let ledgerDocs = [];
      const didRelease = await withTransaction(async (session) => {
        const fresh = await Order.findById(order._id).session(session);
        if (!fresh || fresh.internalStatus !== 'out_of_stock') return false;
        ledgerDocs = await ensureOrderStockHeld(fresh._id, fresh.items, session);
        await transitionOrder(fresh, 'verified_ready_for_shipping', {
          source: 'system',
          actorUserId,
          note: releaseNote,
        }, session);
        return true;
      });
      if (didRelease) {
        await afterLedgerApplied(ledgerDocs);
        released.push(String(order._id));
      }
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

    let ledgerDocs = [];
    if (toStatus === 'verified_ready_for_shipping') {
      ledgerDocs = await ensureOrderStockHeld(order._id, order.items, session);
    }

    await transitionOrder(order, toStatus, meta, session);
    const fresh = await Order.findById(orderId).session(session);
    fresh._ledgerDocs = ledgerDocs;
    return fresh;
  });

  if (toStatus === 'delivered' || toStatus === 'verified_ready_for_shipping') {
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

/** Top up on_hold for any units not already reserved against this order. */
export async function ensureOrderStockHeld(orderId, items, session) {
  const entries = await buildMissingHoldEntries(orderId, items, session);
  if (!entries.length) return [];
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
 * When shopifyWritePolicy=full, pushes sellable qty (realStock − onHoldStock) to Shopify.
 */
export async function setRealStockBatch({ items, reasonCode = 'stock_count', actorUserId }) {
  if (!Array.isArray(items) || !items.length) {
    const err = new Error('items array is required');
    err.statusCode = 400;
    throw err;
  }

  const results = [];
  const allCrossings = [];
  const ledgerForShopify = [];

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
    if (outcome.changed && Array.isArray(outcome.ledgerDocs)) {
      ledgerForShopify.push(...outcome.ledgerDocs);
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
  await enqueueShopifySync(ledgerForShopify);
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

  // Refund: if only collect lines were sent, mirror them into `items` (order schema requires items).
  const outboundItemsInput =
    customerReturn && (!Array.isArray(items) || items.length < 1) && Array.isArray(bostaReturnItems)
      ? bostaReturnItems.map((r) => ({
          variantId: r.variantId,
          quantity: r.quantity || 1,
          unitSellingPrice: 0,
        }))
      : items;

  const manualOrder = await withTransaction(async (session) => {
    let populatedLedger = [];
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
    let outboundGoodsValue = 0;
    for (const item of outboundItemsInput || []) {
      const variant = await Variant.findById(item.variantId).session(session);
      if (!variant) {
        const err = new Error(`Variant not found: ${item.variantId}`);
        err.statusCode = 404;
        throw err;
      }
      const catalogUnit = Number(variant.sellingPrice) || 0;
      const inputUnit = Number(item.unitSellingPrice);
      const unitForDiff =
        Number.isFinite(inputUnit) && inputUnit > 0 ? inputUnit : catalogUnit;
      outboundGoodsValue += unitForDiff * (Number(item.quantity) || 0);
      orderItems.push({
        variantId: variant._id,
        sku: variant.sku,
        quantity: item.quantity,
        // Exchange line prices stay 0 on the order; upgrade amount lives in totalSellingPrice.
        unitSellingPrice: exchange || customerReturn ? 0 : (item.unitSellingPrice ?? variant.sellingPrice),
        unitCogs: variant.cogs,
      });
    }

    if (!orderItems.length) {
      const err = new Error(customerReturn ? 'Select the items to pick up for this return' : 'Add at least one item');
      err.statusCode = 400;
      throw err;
    }

    // Exchange: signed (new − old). Upgrade → totalSellingPrice; downgrade → exchangeCreditAmount.
    // COD = upgrade + shipping − credit (customer still pays shipping when old is more expensive).
    let returnGoodsValue = 0;
    if (exchange && Array.isArray(bostaReturnItems)) {
      const priorUnitByVariant = new Map();
      for (const pi of priorOrder?.items || []) {
        const vid = String(pi.variantId?._id || pi.variantId || '');
        if (!vid) continue;
        priorUnitByVariant.set(vid, Number(pi.unitSellingPrice) || 0);
      }
      for (const r of bostaReturnItems) {
        const vid = String(r.variantId || '');
        const qty = Number(r.quantity) || 0;
        if (!vid || qty < 1) continue;
        let unit = priorUnitByVariant.has(vid) ? priorUnitByVariant.get(vid) : null;
        if (unit == null) {
          const variant = await Variant.findById(vid).session(session);
          unit = Number(variant?.sellingPrice) || 0;
        }
        returnGoodsValue += unit * qty;
      }
    }

    const signedDiff = exchange
      ? Math.round((outboundGoodsValue - returnGoodsValue) * 100) / 100
      : 0;
    const exchangePriceDiff = exchange ? Math.max(0, signedDiff) : 0;
    const exchangeCreditAmount = exchange ? Math.max(0, -signedDiff) : 0;

    const total = customerReturn
      ? 0
      : exchange
        ? exchangePriceDiff
        : totalSellingPrice ?? orderItems.reduce(
            (sum, i) => sum + i.unitSellingPrice * i.quantity,
            0
          );

    // Exchange: COD = (new−old) + shipping; if old > new, credit reduces COD but shipping still applies.
    // Shipping is place-based (prior Shopify city rate / city history) — not a fixed EGP amount.
    // Return pickup: no COD / no shipping collect — courier must not give cash to customer.
    const feeRaw = shippingFee != null ? Number(shippingFee) : null;
    const method = shippingMethod || 'bosta';
    const finalShippingFee = customerReturn
      ? 0
      : exchange
        ? await resolveExchangeShippingFee({
            // Treat 0 / missing as “look up by place” so we never invent a flat fee blindly.
            shippingFee: Number.isFinite(feeRaw) && feeRaw > 0 ? feeRaw : null,
            priorOrder,
            city: shippingAddress?.city || priorOrder?.shippingAddress?.city,
          })
        : method === 'local_shipping'
          ? LOCAL_SHIPPING_FEE
          : method === 'pickup'
            ? 0
            : Number.isFinite(feeRaw) && feeRaw > 0
              ? feeRaw
              : DEFAULT_BOSTA_SHIPPING_FEE;

    const finalShippingAddress =
      method === 'pickup'
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

    const isPickup = method === 'pickup' && !exchange && !customerReturn;
    const now = new Date();

    // Manual orders skip call-center verify:
    // - normal / exchange / local / bosta / customer pickup → Ready to ship
    // - refund / return → Returning to Warehouse (track inbound)
    let initialStatus = 'verified_ready_for_shipping';
    if (customerReturn) initialStatus = 'returning_to_origin';

    // Enrich collect lines with SKU/title from variants so Bosta policy + warehouse confirm are accurate.
    let normalizedReturnItems = [];
    if (Array.isArray(bostaReturnItems) && bostaReturnItems.length) {
      for (const r of bostaReturnItems) {
        const variant = await Variant.findById(r.variantId).session(session);
        if (!variant) {
          const err = new Error(`Return variant not found: ${r.variantId}`);
          err.statusCode = 404;
          throw err;
        }
        normalizedReturnItems.push({
          variantId: variant._id,
          sku: r.sku || variant.sku,
          quantity: r.quantity || 1,
          title: r.title || variant.title,
          color: r.color || variant.color,
          size: r.size || variant.size,
        });
      }
    } else if (customerReturn) {
      normalizedReturnItems = orderItems.map((i) => ({
        variantId: i.variantId,
        sku: i.sku,
        quantity: i.quantity,
      }));
    }

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
        deliveredAt: undefined,
        closedAt: undefined,
        isCreatorOrder: exchange || customerReturn ? false : Boolean(isCreatorOrder),
        isExchangeOrder: exchange,
        exchangeFromOrderId: exchange ? priorOrder._id : undefined,
        exchangeCreditAmount: exchange ? exchangeCreditAmount : 0,
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
                ? 'Pickup auto-verified · Ready to ship · print Gazelle policy on Fulfillment'
                : exchange
                  ? exchangeCreditAmount > 0
                    ? `Exchange auto-verified · Ready to ship · customer credit EGP ${exchangeCreditAmount} · shipping EGP ${finalShippingFee} · net COD EGP ${Math.max(0, total + finalShippingFee - exchangeCreditAmount)} · Bosta EXCHANGE`
                    : `Exchange auto-verified · Ready to ship · upgrade EGP ${total} + shipping EGP ${finalShippingFee} · Bosta EXCHANGE`
                  : 'Manual order auto-verified · Ready to ship',
            actorUserId,
          },
        ],
      }],
      { session }
    );

    if (customerReturn) {
      // Inbound only — no warehouse hold. Stock increments when confirmed in warehouse.
    } else {
      // Ready to ship (normal, creator, exchange, local, pickup, Bosta).
      const ledgerDocs = await reserveStockForOrder(order._id, orderItems, session);
      populatedLedger = ledgerDocs;
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
            ? `Pickup from ${manualSource} · Ready to ship`
            : exchange
              ? exchangeCreditAmount > 0
                ? `Exchange from ${manualSource} (for ${priorLabel}) · Ready to ship · credit EGP ${exchangeCreditAmount} · shipping EGP ${finalShippingFee}`
                : `Exchange from ${manualSource} (for ${priorLabel}) · Ready to ship · upgrade EGP ${total} + shipping EGP ${finalShippingFee}`
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

    populated._ledgerDocs = populatedLedger;
    return populated;
  });

  await afterLedgerApplied(manualOrder?._ledgerDocs);
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
 * Resolve a prior order for exchange / return by Shopify order number.
 * Always searches Shopify for the entered id (any age), then upserts into OMS.
 * Local-only fallback for manual orders (MAN-…) or Mongo ids.
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
  const isManualOrMongo = /^MAN-/i.test(raw) || /^[a-f\d]{24}$/i.test(raw);

  async function populateOrder(docOrId) {
    const id = docOrId?._id || docOrId;
    if (!id) return null;
    return Order.findById(id)
      .populate('customerId', 'fullName phone email')
      .populate('items.variantId', 'title color size imageUrl sku sellingPrice productId')
      .lean();
  }

  // Shopify path: any numeric / #order entered → search Shopify live.
  if (!isManualOrMongo && digits) {
    try {
      const { importShopifyOrderByName } = await import('../integrations/shopify/setup.service.js');
      const imported = await importShopifyOrderByName(raw);
      const order = await populateOrder(imported);
      if (order) return order;
    } catch (err) {
      if (err.statusCode && err.statusCode !== 404 && err.statusCode !== 400) throw err;
      // Continue to local fallback below.
    }
  }

  // Local fallback (manual orders, Mongo id, or Shopify already in OMS if API failed).
  const or = [
    { shopifyOrderName: withHash },
    { shopifyOrderName: raw },
    { shopifyOrderId: raw },
  ];
  if (digits) {
    or.push({ shopifyOrderId: digits });
    or.push({ shopifyOrderName: `#${digits}` });
  }
  if (/^[a-f\d]{24}$/i.test(raw)) or.push({ _id: raw });

  const local = await Order.findOne({ $or: or })
    .sort({ placedAt: -1 })
    .populate('customerId', 'fullName phone email')
    .populate('items.variantId', 'title color size imageUrl sku sellingPrice productId')
    .lean();

  if (!local) {
    const err = new Error(
      `Order ${withHash} not found on Shopify. Check the order number and try again.`
    );
    err.statusCode = 404;
    throw err;
  }

  return local;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Most common recent Shopify/OMS shipping fee for a destination city (place-based, not fixed).
 */
export async function suggestShippingFeeByCity(city) {
  const c = String(city || '').trim();
  if (!c) return null;
  const rows = await Order.aggregate([
    {
      $match: {
        shippingFee: { $gt: 0 },
        'shippingAddress.city': { $regex: new RegExp(`^${escapeRegex(c)}$`, 'i') },
      },
    },
    { $group: { _id: '$shippingFee', n: { $sum: 1 } } },
    { $sort: { n: -1, _id: -1 } },
    { $limit: 1 },
  ]);
  const fee = rows[0]?._id;
  return Number.isFinite(Number(fee)) && Number(fee) > 0 ? Number(fee) : null;
}

/**
 * Resolve exchange shipping: explicit fee → prior order city rate → city history → default.
 */
export async function resolveExchangeShippingFee({
  shippingFee,
  priorOrder,
  city,
} = {}) {
  const feeRaw = shippingFee != null ? Number(shippingFee) : null;
  if (Number.isFinite(feeRaw) && feeRaw > 0) {
    return Math.round(feeRaw * 100) / 100;
  }
  const prior = Number(priorOrder?.shippingFee);
  if (Number.isFinite(prior) && prior > 0) {
    return Math.round(prior * 100) / 100;
  }
  const suggested = await suggestShippingFeeByCity(
    city || priorOrder?.shippingAddress?.city
  );
  if (suggested != null) return suggested;
  return DEFAULT_BOSTA_SHIPPING_FEE;
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

  // Delayed callbacks still sit in verify / no-response with a future (or today) date.
  counts.delayed = await Order.countDocuments({
    placedAt: { $gte: cutoff },
    internalStatus: { $in: ['pending_verification', 'no_response'] },
    delayedUntil: { $exists: true, $ne: null },
  });

  return counts;
}

export async function listOrders({
  status,
  search,
  orderSource,
  shippingMethod,
  isExchangeOrder,
  isReturnOrder,
  delayed,
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
  if (delayed === true || delayed === '1' || delayed === 'true') {
    filter.delayedUntil = { $exists: true, $ne: null };
    if (!status) {
      filter.internalStatus = { $in: ['pending_verification', 'no_response'] };
    }
  }
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

      const digits = term.replace(/^#/, '').trim();
      const withHash = digits.startsWith('#') ? digits : `#${digits}`;
      const digitsRegex = digits ? { $regex: escapeRegex(digits), $options: 'i' } : null;
      const hashRegex = digits ? { $regex: escapeRegex(withHash), $options: 'i' } : null;

      filter.$or = [
        { shopifyOrderId: regex },
        { shopifyOrderName: regex },
        { bostaTrackingNumber: regex },
        { bostaDeliveryId: regex },
        { 'shippingAddress.fullName': regex },
        { 'shippingAddress.phone': regex },
        { 'shippingAddress.city': regex },
        { 'items.sku': regex },
        ...(customerIds.length ? [{ customerId: { $in: customerIds } }] : []),
      ];

      // Order # as shown in UI (#44004) — match with/without hash on name + id.
      if (digits && digitsRegex) {
        filter.$or.push(
          { shopifyOrderId: digitsRegex },
          { shopifyOrderName: digitsRegex },
          { shopifyOrderName: hashRegex },
          { bostaTrackingNumber: digitsRegex },
          { bostaDeliveryId: digitsRegex },
          { 'items.sku': digitsRegex }
        );
      }
    }
  }
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('customerId', 'fullName phone riskFlag lifetimeCancelled')
      .populate({
        path: 'items.variantId',
        select: 'title color size sku productId',
        populate: { path: 'productId', select: 'title' },
      }),
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

/**
 * Apply the same verify/cancel outcome to many orders (queue bulk actions).
 * Each order is processed independently; failures are collected, not fatal for the batch.
 */
export async function bulkVerifyOrders(orderIds, actorUserId, { outcome, note, shippingMethod } = {}) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    const err = new Error('Select at least one order');
    err.statusCode = 400;
    throw err;
  }
  if (!['confirmed', 'no_response', 'customer_cancelled'].includes(outcome)) {
    const err = new Error('outcome must be confirmed, no_response, or customer_cancelled');
    err.statusCode = 400;
    throw err;
  }

  const uniqueIds = [...new Set(orderIds.map((id) => String(id)).filter(Boolean))];
  if (uniqueIds.length > 100) {
    const err = new Error('Maximum 100 orders per bulk action');
    err.statusCode = 400;
    throw err;
  }

  const results = { ok: [], failed: [] };
  const resolvedNote =
    (note && String(note).trim()) ||
    (outcome === 'customer_cancelled' ? 'Bulk cancel from verification queue' : undefined);

  for (const id of uniqueIds) {
    try {
      const body = { outcome };
      if (resolvedNote) body.note = resolvedNote;
      if (shippingMethod && outcome === 'confirmed') body.shippingMethod = shippingMethod;
      await verifyOrder(id, actorUserId, body);
      results.ok.push(id);
    } catch (err) {
      results.failed.push({
        id,
        message: err.message || 'Failed',
      });
    }
  }

  return results;
}

export default {
  verifyOrder,
  bulkVerifyOrders,
  cancelOrder,
  markDelivered,
  confirmReturnedToStock,
  transitionOrderStatus,
  reserveStockForOrder,
  ensureOrderStockHeld,
  manualStockAdjustment,
  stockIntake,
  setRealStockBatch,
  releaseOutOfStockOrdersIfRestocked,
  createManualOrder,
  findOrderForExchange,
  suggestShippingFeeByCity,
  resolveExchangeShippingFee,
  getOrderStateCounts,
  getOrderById,
  listOrders,
  getOrderStatusHistory,
  claimOrder,
  delayOrder,
  processDelayCallbacksDue,
  applyOrderDiscount,
  syncShopifySellableAfterLedger,
};
